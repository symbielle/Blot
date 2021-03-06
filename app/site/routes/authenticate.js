module.exports = function(server){

  var saveCredentials = require('../../dashboard/routes/account/change-dropbox/save-credentials.js');

  var Dropbox = require('dropbox'),
      events = require('events'),
      eventEmitter = new events.EventEmitter(),
      config = require('config'),
      callbackUrl = 'https://' + config.host + '/auth/callback',
      User = require('user'),
      Subscription = require('subscription'),
      logger = require('helper').logger;

  var errorMessage = {
    NO_ACCOUNT: 'You need a Blot account to log in'
  };

  server.get('/auth', function (request, response) {

    // If the user is already authenticated then
    // avoid repeating the auth process UNLESS
    // the user has visited this endpoint because
    // they want to log into a different Dropbox account
    if (request.session.uid && !request.query.change_account) {
      var afterAuth = request.session.afterAuth;
      delete request.session.afterAuth;
      return response.redirect(afterAuth || '/');
    }

    var _session = {};

    // We also use this route to switch
    // the Dropbox account associated with a Blot
    // account. We save this in the session because
    // I couldn't be bothered to add a new callback
    // url. The session is preserved in the next block.
    if (request.query.change_account)
      request.session.change_account = true;

    // Cache the current session so we can
    // link a newly authenticated user to
    // someone who just bought an account.
    for (var i in request.session)
      _session[i] = request.session[i];

    // Get a fresh session ID to use during auth
    request.session.regenerate(function(error){

      if (error) throw error;

      // Replace the old session content
      for (var j in _session)
        request.session[j] = _session[j];

      var client = new Dropbox.Client(config.dropbox),
          sessionID = request.sessionID;

      // Register a new authDriver. We pass the request &
      // response so we can redirect the user to Dropbox.
      client.authDriver(new authDriver(request, response));

      // Start the authentication flow.
      client.authenticate(function(error, client){

        // This function is invoked when the user returns
        // to /auth/callback and so we pass the client
        eventEmitter.emit(clientReady(sessionID), error, client);
      });
    });
  });

  server.get('/auth/callback', function (request, response, next) {

    var code = request.query.code;
    var error = request.query.error;

    // I'll probably need to add a specific error handler
    // here for folks who want to change Dropbox account
    // if (error && request.session.change_account) return ...

    if (error) return response.redirect(connectError(error));

    if (!code) return response.redirect('/auth');

    var subscription = request.session.subscription;
    var email = request.session.email;
    var newUser = request.session.newUser;
    var sessionID = request.sessionID;

    var afterAuth = request.session.afterAuth;

    delete request.session.afterAuth;

    // Tell auth driver to try and create an OAuth token
    eventEmitter.emit(backFromDropbox(sessionID), {code: code});

    // Once the auth driver has attempted to create a
    // client this function will be called.
    eventEmitter.once(clientReady(sessionID), function(error, client){

      if (error || !client.isAuthenticated())
        return response.redirect(connectError(error));

      // Don't try and create a new user if the user
      // actually wants to change Dropbox account...
      if (request.session.change_account)
        return saveCredentials(request, response, next, client);

      var uid = client.dropboxUid();

      // Check if the user has registered with Blot
      User.getBy({uid: uid}, function(err, existingUser){

        if (err) throw err;

        // Catch users without a Blot account
        if (!newUser && !existingUser) {
          logger(uid, errorMessage.NO_ACCOUNT);
          return response.redirect(formError(errorMessage.NO_ACCOUNT));
        }

        // Authenticate the user
        request.session.uid = uid;

        // And store their blog if possible
        if (existingUser) {
          request.session.blogID = existingUser.lastSession;
        }

        if (newUser) {

          // Ensure the user's stripe subscription info is connected
          // to their Dropbox (and Blot) account UID
          Subscription.bind(subscription.customer, uid, function(){

            User.create(client, email, subscription, function(error){

              if (error) return next(error);

              if (subscription.customer === 'false') {
                logger('Created free user successfully with email ' + email);
              }

              // Make sure the information about
              // the charge doesn't persist to confuse
              // other routes or this route if re-login
              delete request.session.email;
              delete request.session.subscription;

              response.redirect('/account/create-blog');
            });
          });
        }

        else if (existingUser) {

          // Disabled users have chosen to be so
          // this will happen to users who have not paid too
          // The user is NOT authenticated
          if (existingUser.isDisabled) {
            response.redirect('/account/disabled');
          } else {
            response.redirect(afterAuth || '/');
          }

          User.update(client, function(error){

            if (error) logger(null, error);
          });
        }
      });
    });
  });

  function authDriver (request, response) {

    return {

      authType: function() {return 'code';},

      url: function() {return callbackUrl;},

      doAuthorize: function(authUrl, state, client, callback) {

        var sessionID = request.sessionID;

        // This event is emitted when the user hits /auth/callback
        // and will tell the Dropbox client to proceed with auth
        eventEmitter.once(backFromDropbox(sessionID), callback);

        // Redirect the user to Dropbox.com to click 'authorize'
        response.redirect(authUrl);
      }
    };
  }

  function clientReady (sessionID) {
    return 'clientReady:' + sessionID;
  }

  function backFromDropbox (sessionID) {
    return 'hasReturned:' + sessionID;
  }

  function connectError (message) {
    return '/connect?error=' + encodeURIComponent(message);
  }

  function formError (message) {
    return '/sign-up?error=' + encodeURIComponent(message);
  }
};