// node-inspector version of on webkit-inspector/DebuggerAgent.cpp

var convert = require('./convert.js'),
  async = require('async');

/**
 * @param {FrontendClient} frontendClient
 * @param {DebuggerClient} debuggerClient
 * @param {BreakEventHandler} breakEventHandler
 * @param {ScriptManager} scriptManager
 * @constructor
 */
function DebuggerAgent(frontendClient,
                       debuggerClient,
                       breakEventHandler,
                       scriptManager) {
  this._frontendClient = frontendClient;
  this._debuggerClient = debuggerClient;
  this._breakEventHandler = breakEventHandler;
  this._scriptManager = scriptManager;
}

DebuggerAgent.prototype = {
  canSetScriptSource: function(params, done) {
    done(null, { result: true });
  },

  enable: function(params, done) {
    this._debuggerClient.on(
      'connect',
      function() {
        done();
        this._onDebuggerConnect();
      }.bind(this)
    );

    this._debuggerClient.connect();
  },

  _onDebuggerConnect: function() {
    async.waterfall([
      // Remove all existing breakpoints because:
      // 1) front-end inspector cannot restore breakpoints from debugger anyway
      // 2) all breakpoints were disabled when the previous debugger-client
      //    disconnected from the debugged application
      this._removeAllBreakpoints.bind(this),
      this._reloadScripts.bind(this),
      this._sendBacktraceIfPaused.bind(this)
    ]);
  },

  _removeAllBreakpoints: function(done) {
    this._debuggerClient.request(
      'listbreakpoints',
      {},
      function(err, response) {
        if (err) {
          console.log('Warning: cannot remove old breakpoints. %s', err);
          done();
          return;
        }

        function removeOneBreakpoint(bp, next) {
          this._debuggerClient.clearBreakpoint(
            bp.number,
            function(error) {
              if (error)
                console.log(
                  'Warning: cannot remove old breakpoint %d. %s',
                  bp.number,
                  error
                );
              next();
            }
          );
        }

        async.eachSeries(
          response.breakpoints,
          removeOneBreakpoint.bind(this),
          done
        );
      }.bind(this)
    );
  },

  _reloadScripts: function(done) {
    this._scriptManager.reset();
    this._debuggerClient.request(
      'scripts',
      {
        includeSource: false,
        types: 4
      },
      function handleScriptsResponse(err, result) {
        if (err) {
          done(err);
          return;
        }

        result.forEach(this._scriptManager.addScript.bind(this._scriptManager));
        done();
      }.bind(this)
    );
  },

  _sendBacktraceIfPaused: function(done) {
    if (!this._debuggerClient.isRunning) {
      this._breakEventHandler.sendBacktraceToFrontend(null);
    }
    done();
  },

  disable: function(params, done) {
    this._debuggerClient.close();
    done();
  },

  resume: function(params, done) {
    this._sendContinue(undefined, done);
  },

  _sendContinue: function(stepAction, done) {
    var args = stepAction ? { stepaction: stepAction } : undefined;
    this._debuggerClient.request('continue', args, function(error, result) {
      done(error);
      if (!error)
        this._frontendClient.sendEvent('Debugger.resumed');
    }.bind(this));
  },

  pause: function(params, done) {
    this._debuggerClient.request('suspend', {}, function(error, result) {
      done(error);
      if (!error) {
        this._breakEventHandler.sendBacktraceToFrontend(null);
      }
    }.bind(this));
  },

  stepOver: function(params, done) {
    this._sendContinue('next', done);
  },

  stepInto: function(params, done) {
    this._sendContinue('in', done);
  },

  stepOut: function(params, done) {
    this._sendContinue('out', done);
  },

  continueToLocation: function(params, done) {
    var requestParams = {
      type: 'scriptId',
      target: convert.inspectorScriptIdToV8Id(params.location.scriptId),
      line: params.location.lineNumber,
      column: params.location.columnNumber
    };

    this._debuggerClient.request('setbreakpoint', requestParams, function(error, response) {
      if (error != null) {
        done(error);
        return;
      }

      this._breakEventHandler.
        continueToLocationBreakpointId = response.breakpoint;

      this._debuggerClient.request('continue', undefined, function(error, response) {
        done(error);
      });
    }.bind(this));
  },

  getScriptSource: function(params, done) {
    this._debuggerClient.request(
      'scripts',
      {
        includeSource: true,
        types: 4,
        ids: [params.scriptId]
      },
      function handleScriptSourceResponse(err, result) {
        if (err) {
          done(err);
          return;
        }

        done(null, { scriptSource: result[0].source });
      });
  },

  setScriptSource: function(params, done) {
    this._debuggerClient.request(
      'changelive',
      {
        script_id: convert.inspectorScriptIdToV8Id(params.scriptId),
        new_source: params.scriptSource,
        preview_only: false
      },
      function handleChangeLiveResponse(err, response) {
        if (err) {
          done(err);
          return;
        }

        var debuggerClient = this._debuggerClient;
        var frontendClient = this._frontendClient;
        var breakEventHandler = this._breakEventHandler;

        function sendResponse(callframes) {
          done(
            null,
            {
              callFrames: callframes || [],
              result: response.result
            }
          );
        }

        function sendResponseWithCallStack() {
          breakEventHandler.fetchCallFrames(function(err, response) {
            var callframes = [];
            if (err) {
              frontendClient.sendLogToConsole(
                'error',
                'Cannot update stack trace after a script changed: ' + err);
            } else {
              callframes = response;
            }
            sendResponse(callframes);
          });
        }

        function stepIntoAndSendResponse() {
          // TODO remove this when front-end supports
          // stack_update_needs_step_in for live-edit
          // See comment in front-end/Script.js > didEditScriptSource()
          breakEventHandler.callbackForNextBreak = function(data) {
            sendResponseWithCallStack();
          };
          debuggerClient.request(
            'continue',
            { stepAction: 'in' },
            function(err, response) {
              if (err) {
                frontendClient.sendLogToConsole(
                  'error',
                  'Cannot execute step-into after a script changed: ' + err +
                    '\nPlease perform step-into yourself from the GUI.');
                sendResponseWithCallStack();
              }
            }
          );
        }

        if (response.result.stack_update_needs_step_in)
          stepIntoAndSendResponse();
        else if (response.result.stack_modified)
          sendResponseWithCallStack();
        else
          sendResponse();
      }.bind(this)
    );
  },

  setPauseOnExceptions: function(params, done) {
    var args = [
      { type: 'all', enabled: params.state == 'all' },
      { type: 'uncaught', enabled: params.state == 'uncaught' }
    ];

    async.eachSeries(
      args,
      function(arg, next) {
        this._debuggerClient.request('setexceptionbreak', arg, next);
      }.bind(this),
      done);
  },

  setBreakpointByUrl: function(params, done) {
    if (params.urlRegex !== undefined) {
      // DevTools protocol defines urlRegex parameter,
      // but the parameter is not used by the front-end.
      done('Error: setBreakpointByUrl using urlRegex is not implemented.');
      return;
    }

    var requestParams = {
      type: 'script',
      target: convert.inspectorUrlToV8Name(params.url),
      line: params.lineNumber,
      column: params.columnNumber,
      condition: params.condition
    };

    this._debuggerClient.request('setbreakpoint', requestParams, function(error, response) {
      if (error != null) {
        done(error);
        return;
      }

      done(null, {
        breakpointId: response.breakpoint.toString(),
        locations: response.actual_locations.map(convert.v8LocationToInspectorLocation)
      });
    });
  },

  removeBreakpoint: function(params, done) {
    this._debuggerClient.clearBreakpoint(
      params.breakpointId,
      function(error, response) {
        done(error, null);
      }
    );
  },

  setBreakpointsActive: function(params, done) {
    this._debuggerClient.request('listbreakpoints', {}, function(error, response) {
      if (error) {
        done(error);
        return;
      }

      function setBreakpointState(bp, next) {
        var req = { breakpoint: bp.number, enabled: params.active };
        this._debuggerClient.request('changebreakpoint', req, next);
      }

      async.eachSeries(response.breakpoints, setBreakpointState.bind(this), done);
    }.bind(this));
  },

  setOverlayMessage: function(params, done) {
    done();
  },

  evaluateOnCallFrame: function(params, done) {
    var self = this;
    var expression = params.expression;
    var frame = Number(params.callFrameId);

    self._debuggerClient.request(
      'evaluate',
      {
        expression: params.expression,
        frame: frame
      },
      function(err, result) {
        // Errors from V8 are actually just messages, so we need to fill them out a bit.
        if (err) {
          err = convert.v8ErrorToInspectorError(err);
        }

        done(null, {
          result: err || convert.v8ResultToInspectorResult(result),
          wasThrown: !!err
        });
      }
    );
  },

  getFunctionDetails: function(params, done) {
    var handle = params.functionId;
    this._debuggerClient.request(
      'lookup',
      {
        handles: [handle],
        includeSource: false
      },
      function(error, responseBody) {
        if (error) {
          done(error);
        } else {
          done(null, convert.v8FunctionLookupToFunctionDetails(responseBody[handle]));
        }
      }.bind(this));
  }
};

exports.DebuggerAgent = DebuggerAgent;