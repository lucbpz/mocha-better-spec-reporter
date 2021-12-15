var util = require('util');
var diff = require('diff');
var stacktrace = require('stack-trace');
var fs = require('graceful-fs');
var path = require('path');

var minimatch = require('minimatch');

var getType = require('should-type');
var format = require('should-format');

var config = require('./config');
var symbols = config.symbols;

var color = require('./color');
var formatTime = require('./time').formatTime;

var pad = require('./pad');

var SourceMapConsumer = require('source-map').SourceMapConsumer;

var dataUriToBuffer = require('data-uri-to-buffer');

const rules = [
  {
    match: /^You are using the simple \(heuristic\) fragment matcher/,
    group: "Apollo: You are using the simple (heuristic) fragment matcher.",
  },
  {
    match: /^Heuristic fragment matching going on/,
    group: null, // ignore outright
  },
  {
    match: /^Warning: An update to (\w*) inside a test was not wrapped in act/,
    group: "React: Act warnings",
    keep: true, // TODO: implement this. include in summary, but also keep raw console output 
  },
  {
    match: /^Warning: componentWillReceiveProps has been renamed/,
    group: "React deprecation warning: componentWillReceiveProps",
  },
  {
    match: /^Warning: componentWillMount has been renamed/,
    group: "React deprecation warning: componentWillMount",
  },
  {
    match: /react-beautiful-dnd/,
    group: 'React draggable component',
  },
  {
    match: /^Warning: unmountComponentAtNode/,
    group: 'React unmounted component at node warning'
  },
  {
    match: /^Warning: Can't perform a React state update on an unmounted component/,
    group: 'React unmounted component: cannot perform a React state update'
  },
  {
    match: /^Warning: Encountered two children with the same key/,
    group: 'React children: two children with the same key'
  },
  {
    match: /^Warning: Each child in a list should have a unique "key" prop/,
    group: 'React children: each child must have a unique key',
  },
  {
    match: /^The width(0) and height(0)/,
    group: 'Recharts: React component with no width and height',
  }
];

function getRuleMatched(message) {
  return rules.find(rule => (new RegExp(rule.match)).test(message));
}

function addToCount(matchedRule) {
  if(!matchedRule) return;
  if (matchedRule.count === undefined) matchedRule.count = 0;
  matchedRule.count += 1;
}

function getSeverityAndColor(severity) {
  switch (severity) {
    case 'INFO':
      return {color: 'stat', severity: 'INFO'};
    case 'WARN':
      return {color: 'pending', severity: 'WARN'};
    case 'ERROR':
      return {color: 'fail', severity: 'ERROR'};
  }
}

const addSeverity = (severity) => (matchedRule) => {
  if (matchedRule && !matchedRule.color) {
    matchedRule.color = getSeverityAndColor(severity).color;
    matchedRule.severity = getSeverityAndColor(severity).severity;
  }
  return matchedRule;
}

function parseEnvOptions(opts) {
  var v = process.env.MOCHA_REPORTER_OPTS || '',
      s = process.env.MOCHA_REPORTER_STACK_EXCLUDE;

  if(s) {
    opts.stackExclude = s;
  }

  opts.hideTitles = ~v.indexOf('hide-titles');
  opts.hideStats = ~v.indexOf('hide-stats');
  opts.clearScreen = ~v.indexOf('clear-screen');

  return opts;
}

function parseMochaReporterOptions(opts, reporterOptions) {
  if('hide-titles' in reporterOptions)
    opts.hideTitles = reporterOptions['hide-titles'] === 'true';

  if('hide-stats' in reporterOptions)
    opts.hideStats = reporterOptions['hide-stats'] === 'true';

  if('clear-screen' in reporterOptions)
    opts.clearScreen = reporterOptions['clear-screen'] === 'true';

  if('stack-exclude' in reporterOptions)
    opts.stackExclude = reporterOptions['stack-exclude'];

  if('show-back-order' in reporterOptions)
    opts.showFailsInBackOrder = reporterOptions['show-back-order'] === 'true';

  if('show-file-content' in reporterOptions) {
    opts.showSourceMapFiles = ~reporterOptions['show-file-content'].indexOf("sm")
    opts.showJavascriptFiles = ~reporterOptions['show-file-content'].indexOf("js")
  }

  return opts;
}

function Reporter(runner, mochaOptions) {
  if(!runner) return;
  this.runner = runner;

  var that = this;

  this.options = {
    showSourceMapFiles: false,
    showFailsInBackOrder: false,
    mockConsole: true,
    hideNodeModulesStack: true,
    hideTestingLibraryDOM: true,
  };

  this.options = parseEnvOptions(this.options);
  this.options = parseMochaReporterOptions(this.options, mochaOptions.reporterOptions || {});

  if(!this.options.showSourceMapFiles && !this.options.showJavascriptFiles) {
    this.options.showJavascriptFiles = true;
  }

  const consoleInfos = [];
  const consoleWarns = [];
  const consoleErrors = [];
  /* --------------------------- */
  /* <Mock console> */
  this.logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.log = (message) => {
    const matchedRule = getRuleMatched(message);
    addSeverity('INFO')(matchedRule);
    addToCount(matchedRule);
    consoleInfos.push(message);
    if (!this.options.mockConsole) {
      this.logger.info(message);
    } else if (matchedRule && matchedRule.keep) {
      this.logger.info(message);
    }
  };
  console.warn = (message) => {
    const matchedRule = getRuleMatched(message);
    addSeverity('WARN')(matchedRule);
    addToCount(matchedRule);
    consoleWarns.push(message);
    if (!this.options.mockConsole) {
      this.logger.warn(message);
    } else if (matchedRule && matchedRule.keep) {
      this.logger.warn(message);
    }
  }
  console.error = (message) => {
    const matchedRule = getRuleMatched(message);
    addSeverity('ERROR')(matchedRule);
    addToCount(matchedRule);
    consoleErrors.push(message);
    if (!this.options.mockConsole) {
      this.logger.error(message);
    } else if (matchedRule && matchedRule.keep) {
      this.logger.error(message);
    }
  }
  /* </Mock console> */
  /* --------------------------- */

  var stats = this.stats = {suites: 0, tests: 0, passes: 0, pending: 0, failures: 0, timeouts: 0};
  var failures = this.failures = [];

  this.indentation = 0;

  this.files = mochaOptions.files;
  this.filesCache = {};
  this.sourceMapCache = {};

  runner.on('start', function() {
    stats.start = new Date;
    if(that.options.clearScreen) {
      process.stdout.write('\u001b[2J'); // clear screen.
      process.stdout.write('\u001b[1;3H'); // set cursor position.
    }
  });

  runner.on('suite', function(suite) {
    if(!suite.root) {
      stats.suites++;
      that.indentation++;

      if(!that.options.hideTitles) {
        that.writeLine();
        that.writeLine('%s', color('suite title', suite.title));
      }
    }
  });

  runner.on('suite end', function(suite) {
    if(!suite.root) {
      that.indentation--;
    }
  });

  runner.on('test end', function() {
    stats.tests++;
  });

  runner.on('pass', function(test) {
    stats.passes++;

    that.writeTest(test);
  });

  runner.on('fail', function(test, err) {
    test.err = err;
    test.timedOut = test.duration >= test.timeout();
    if(test.timedOut) stats.timeouts++;
    failures.push(test);

    that.writeTest(test);
  });

  runner.on('pending', function(test) {
    stats.pending++;

    that.writeTest(test);
  });

  runner.on('end', function() {
    stats.end = new Date;
    stats.duration = stats.end - stats.start;

    that.indentation = 0;

    if(!that.options.hideTitles) {
      that.writeLine();
    }

    if(failures.length) that.writeFailures(failures);

    if(!that.options.hideStats) {
      that.writeStat(stats);
      that.writeSuppressedConsoleMessages(rules, consoleInfos.length + consoleWarns.length + consoleErrors.length);
    }
  });
}


Reporter.prototype.writeTest = function writeTest(test) {
  var state = test.pending ? 'pending' : test.state;
  var prefix = symbols[state];
  if(state == 'failed') {
    prefix = '' + (this.stats.failures + 1) + ')';
    this.stats.failures++;
  }
  this.indentation += 0.5;

  if(!this.options.hideTitles) {
    this.writeLine(
        '%s %s',
        color('option ' + state, prefix),
        color('test title ' + state, test.title + (test.timedOut ? ' (timeout)' : '')));
  }

  this.indentation -= 0.5;
};

function indent(indentation) {
  return new Array(Math.round(indentation * config.indentation)).join(' ');
}

Reporter.prototype.writeLine = function() {
  config.stream.write(indent(this.indentation) + util.format.apply(util, arguments) + '\n');
};

Reporter.prototype.writeStat = function(stats) {
  this.writeLine();
  this.writeLine('------------------------------------------------------');
  if(stats.suites) {
    this.writeLine(color('stat', 'Executed %d tests in %d suites in %s'), stats.tests, stats.suites, formatTime(stats.duration));
  } else {
    this.writeLine(color('stat', 'Executed %d tests in %s'), stats.tests, formatTime(stats.duration));
  }
  this.indentation++;
  if(stats.tests == stats.passes)
    this.writeLine(color('pass', 'All passes'));
  else {
    this.writeLine(color('pass', '%d passes'), stats.passes);
    if(stats.pending)
      this.writeLine(color('pending', '%d pending'), stats.pending);
    if(stats.failures) {
      if(stats.timeouts)
        this.writeLine(color('fail', '%d failed (%d timed out)'), stats.failures, stats.timeouts);
      else
        this.writeLine(color('fail', '%d failed'), stats.failures);
    }
  }
  this.indentation--;
};

Reporter.prototype.writeSuppressedConsoleMessages = function(rules, total) {
  this.writeLine('------------------------------------------------------');
  this.writeLine(color('stat', 'Suppressed console messages'));
  this.indentation++;
  // this.logger.info(rules)
  rules.forEach(rule => {
    if (rule.count) {
      this.writeLine(color(rule.color, rule.severity), `${rule.group} (${rule.count})`);
    }
  });
  this.writeLine(`TOTAL Messages Suppressed (${total})`)
  this.indentation--;

}

Reporter.prototype.printErrorMessage = function(message) {
  if (this.options.hideTestingLibraryDOM && message.includes('Unable to find an element')) {
    this.writeLine(color('error message', '%s'), message.split('\n')[0]);
  } else {
    message.split('\n').forEach(function(messageLine) {
      this.writeLine(color('error message', '%s'), messageLine);
    }, this);
  }

}


Reporter.prototype.writeFailures = function(failures) {
  this.writeLine('------------------------------------------------------');
  this.writeLine(color('stat', 'Failed tests'));
  this.indentation++;

  if(this.options.showFailsInBackOrder)
    failures = failures.reverse();

  failures.forEach(function(test, i) {
    var err = test.err,
        message = err.message,
        stack = err.stack,
        actual = err.actual,
        expected = err.expected,
        escape = true;

    if(this.options.showFailsInBackOrder)
      i = failures.length - 1 - i;

    var parsedStack = stacktrace.parse(err);

    var index = stack.indexOf(message);
    stack = stack.substr(index + message.length).split('\n').map(function(line) {
      return line.trim();
    });

    this.writeLine();
    this.writeLine(color('fail', '%d) %s'), i + 1, test.titlePath().join(' > '));
    this.writeLine();

    this.indentation++;
    this.printErrorMessage(message);
    // this.indentation--;


    if(!test.timedOut) {
      var typeA = typeof actual;

      //we do not stringify strings
      if(sameType(actual, expected) && typeA !== 'string') {
        escape = false;
        actual = stringify(actual);
        expected = stringify(expected);
      }

      // actual / expected diff
      // actual !== expected added because node assert assume actual and expected
      // to be undefined maybe need more accurate check
      if(typeof actual === 'string' && typeof expected === 'string' && actual !== expected) {
        this.writeDiff(actual, expected, escape);
      }

      this.writeLine();

      var isFilesBeforeTests = true, isTestFiles = true;

      stack
        .filter(function(l) {
          return l.length > 0;
        })
        .forEach(function(line, i) {
          var fileName = parsedStack[i].getFileName(),
            lineNumber = parsedStack[i].getLineNumber(),
            columnNumber = parsedStack[i].getColumnNumber();

          if (this.options.hideNodeModulesStack && !fileName.includes('node_modules')) {
            if(~this.files.indexOf(fileName)) {
              isTestFiles = true;
              isFilesBeforeTests = false;
            } else {
              isTestFiles = false;
            }

            if((isTestFiles || isFilesBeforeTests) && (!this.options.stackExclude || !minimatch(fileName, this.options.stackExclude))) {
              this.writeStackLine(line, fileName, lineNumber, columnNumber);
            }
          }
        }, this);
    }

    this.indentation--;

  }, this);
  this.indentation--;
};

var sourceMapComment = "//# sourceMappingURL=";

function linesContainSourceMap(lines) {
  var l = lines.length;
  while(l--) {
    var line = lines[l].trim();
    if(line !== '') {
      if(line.substr(0, sourceMapComment.length) === sourceMapComment) {
        return line.substr(sourceMapComment.length);
      }
    }
  }
}

function parseInlineSourceMap(sm) {
  if(sm.substr(0, 5) === 'data:') {
    var buf = dataUriToBuffer(sm);
    return new SourceMapConsumer(buf.toString());
  }
}

function parseExternalSourceMap(filePath, sm) {
  var smPath = path.resolve(path.dirname(filePath), sm);
  try {
    return new SourceMapConsumer(fs.readFileSync(smPath, {encoding: 'utf8'}));
  } catch(e) {
    return null;
  }
}

Reporter.prototype._writeStackFilePosition = function(lines, pos) {
  var ln = {};
  ln[pos.line - 2] = lines[pos.line - 2];
  ln[pos.line - 1] = lines[pos.line - 1];
  ln[pos.line] = lines[pos.line];

  this.writeLine();
  this.writeFilePosition(ln, pos);
  this.writeLine();
}

Reporter.prototype.writeStackLine = function(line, fileName, lineNumber, columnNumber) {
  this.writeLine(color('error stack', line));

  var pos = { line: lineNumber };
  if(columnNumber) pos.column = columnNumber;

  if(lineNumber != null) {
    if(this.filesCache[fileName] === undefined) {
      try {
        this.filesCache[fileName] = fs.readFileSync(fileName, {encoding: 'utf8'}).split('\n');
      } catch(e) {
        //do nothing
      }
    }
    if(this.filesCache[fileName]) {
      var lines = this.filesCache[fileName];

      var sm = linesContainSourceMap(lines);

      if(this.options.showJavascriptFiles || !sm) {
        this._writeStackFilePosition(lines, pos);
      }

      if(sm && this.options.showSourceMapFiles) {
        var smc = this.sourceMapCache[fileName];
        if(smc !== null) {
          smc = parseInlineSourceMap(sm) || parseExternalSourceMap(fileName, sm);
          this.sourceMapCache[fileName] = smc;
        }

        if(smc) {
          var posSM = smc.originalPositionFor(pos);
          if(posSM.source) {
            // i assume that inline source map contains all files content (or it will be useless, because files can be moved)
            var fileContent = smc.sourceContentFor(posSM.source, true);
            if(fileContent) {
              this.indentation++;

              this.writeLine(color('error stack source-map', "at " + posSM.source + ":" + posSM.line + (posSM.column ? ":" + posSM.column: "")));

              if(posSM.column) posSM.column++;
              this._writeStackFilePosition(fileContent.split('\n'), posSM);

              this.indentation--;
            }
          }
        }
      }
    }
  }
}

Reporter.prototype.writeFilePosition = function(lines, filePos) {
  var linenums = Object.keys(lines).map(function(l) { return parseInt(l, 10); });

  var longestLength = linenums
      .filter(function(n) {
        return !!lines[n]
      })
      .map(function(n) {
        return ('' + (n + 1)).length;
      })
      .reduce(function(acc, n) {
        return Math.max(acc, n)
      });// O_O Omg

  linenums.forEach(function(ln) {
    var line = lines[ln];

    if(line) {
      if(ln + 1 == filePos.line) {
        if(filePos.column) {
          var lineBefore = line.substr(0, filePos.column - 1);
          var lineAfter = line.substr(filePos.column);
          line = lineBefore + color('error line pos', line[filePos.column - 1]) + lineAfter;
        }
        this.writeLine('%s | %s', color('error line pos', pad('' + (ln + 1), longestLength)), line);
      } else {
        this.writeLine('%s | %s', pad('' + (ln + 1), longestLength), line);
      }
    }
  }, this);
}

Reporter.prototype.writeDiff = function(actual, expected, escape) {
  var lines = diff.createPatch('str', actual, expected).split('\n').slice(4);

  this.writeLine();
  this.writeLine(color('diff added', '+ expected') + ' ' + color('diff removed', '- actual'));
  this.writeLine();

  lines.forEach(function(line) {
    if(!line.length) return;
    var begining = line.substr(0, 1);
    if(escape) line = escapeInvisibles(line);
    var added = begining == '+';
    var removed = begining == '-';
    var usual = begining == ' ';
    if(!added && !removed && !usual) return;

    line = added ? color('diff added', line) : removed ? color('diff removed', line) : line;
    this.writeLine(line);
  }, this)
};

function stringify(obj) {
  return format(obj, {maxLineLength: 0, propSep: ''});
}

function sameType(a, b) {
  var tA = getType(a), tB = getType(b);
  return tA.type === tB.type && tA.cls === tB.cls && tA.sub === tB.sub;
}

function escapeInvisibles(line) {
  return line
      .replace(/\t/g, '<TAB>')
      .replace(/\r/g, '<CR>')
      .replace(/\n/g, '<LF>\n');
}


module.exports = Reporter;
