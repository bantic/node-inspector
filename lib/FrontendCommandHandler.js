var RuntimeAgent = require('./RuntimeAgent').RuntimeAgent,
  PageAgent = require('./PageAgent').PageAgent,
  DebuggerAgent = require('./DebuggerAgent').DebuggerAgent;

function FrontendCommandHandler(frontendClient,
                                debuggerClient,
                                breakEventHandler,
                                scriptManager) {
  this._agents = {};
  this._specialCommands = {};
  this._frontendClient = frontendClient;
  this._debuggerClient = debuggerClient;
  this._breakEventHandler = breakEventHandler;
  this._scriptManager = scriptManager;
  this._initializeRegistry();
  this._registerEventHandlers();
}

FrontendCommandHandler.prototype = {
  _initializeRegistry: function() {
    this._registerAgent(
      'Debugger',
      new DebuggerAgent(
        this._frontendClient,
        this._debuggerClient,
        this._breakEventHandler,
        this._scriptManager)
    );

    this._registerAgent('Runtime', new RuntimeAgent(this._debuggerClient));
    this._registerAgent('Page', new PageAgent(this._debuggerClient));

    this._registerNoopCommands(
      'Network.enable',
      'Console.enable',
      'Database.enable',
      'DOMStorage.enable',
      'DOM.hideHighlight',
      'Inspector.enable',
      'Profiler.enable',
      'CSS.enable'
    );

    this._registerQuery('CSS.getSupportedCSSProperties', { cssProperties: []});
    this._registerQuery('Worker.canInspectWorkers', { result: false });
  },

  _registerAgent: function(name, agent) {
    this._agents[name] = agent;
  },

  _registerNoopCommands: function() {
    var i, fullMethodName;
    for (i = 0; i < arguments.length; i++) {
      fullMethodName = arguments[i];
      this._specialCommands[fullMethodName] = {};
    }
  },

  _registerQuery: function(fullMethodName, result) {
    this._specialCommands[fullMethodName] = { result: result };
  },

  _registerEventHandlers: function() {
    this._frontendClient.on(
      'message',
       this._handleFrontendMessage.bind(this));
  },

  _handleFrontendMessage: function(message) {
    var command = JSON.parse(message);
    this.handleCommand(command);
  },

  handleCommand: function(messageObject) {
    var fullMethodName = messageObject.method,
      domainAndMethod = fullMethodName.split('.'),
      domainName = domainAndMethod[0],
      methodName = domainAndMethod[1],
      agent,
      method;

    if (this._specialCommands[fullMethodName]) {
      this._handleMethodResult(
        messageObject.id,
        fullMethodName,
        null,
        this._specialCommands[fullMethodName].result);
      return;
    }

    agent = this._agents[domainName];
    if (!agent) {
      console.log(
        'Received request for an unknown domain %s: %s',
        domainName,
        fullMethodName);
      return;
    }

    method = agent[methodName];
    if (!method || typeof method !== 'function') {
      console.log(
        'Received request for an unknown method %s: %s',
        methodName,
        fullMethodName);
      return;
    }


    method.call(agent, messageObject.params, function(error, result) {
      this._handleMethodResult(messageObject.id, fullMethodName, error, result);
    }.bind(this));
  },

  _handleMethodResult: function(requestId, fullMethodName, error, result) {
    var response;

    if (!requestId) {
      if (response !== undefined)
        console.log('Warning: discarded result of ' + fullMethodName);
      return;
    }

    this._frontendClient.sendResponse(requestId, error, result);
  }
};

exports.FrontendCommandHandler = FrontendCommandHandler;