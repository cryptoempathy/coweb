//
// Bayeux implementation of the SessionInterface.
//
// @todo: dojo replacement
// 
// Copyright (c) The Dojo Foundation 2011. All Rights Reserved.
// Copyright (c) IBM Corporation 2008, 2011. All Rights Reserved.
//
define([
    'coweb/session/bayeux/SessionBridge'
], function(bridge) {
    var bayeux = function() {
        // vars set during runtime
        this._prepParams = null;
        this._lastPrep = null;
        // params to be set by init
        this._debug = false;
        this._bridge = null;
        this._listener = null;
        this._destroying = false;
        this._disconnectTok = null;
        this._loginUrl = null;
        this._logoutUrl = null;
    };

    /**
     * Stores parameters.
     *
     * @param params Parameters given to the session factory function
     */
    bayeux.prototype.init = function(params) {
        var self = this;
        // store debug and strict compat check flags for later
        this._loginUrl = params.loginUrl;
        this._logoutUrl = params.logoutUrl;
        this._debug = params.debug;
        this._listener = params.listener;
        // create the client impl
        this._bridge = new bridge({
            debug : this._debug,
            listener: this._listener,
            adminUrl : params.adminUrl
        });
        // track disconnect token
        this._disconnectTok = dojo.connect(this._bridge, 'onDisconnected', 
            this, '_onDisconnected');
        
        // cleanup on destroy, important that this comes after the session
        // controller creation so this instance can notify about the end of the
        // session before the session connection is lost
        var destroy = function() { self.destroy() };
        if(this._bridge.supportsBeforeUnload) {
            dojo.addOnUnload(destroy);
        } else {
            dojo.addOnWindowUnload(destroy);
        }
    };


    /**
     * Called on page unload to disconnect properly.
     */
    bayeux.prototype.destroy = function() {
        // set destroying state to avoid incorrect notifications
        this._destroying = true;
        if(this._bridge.getState() == this._bridge.UPDATED) {
            // broadcast a final hub event indicating the client is now leaving
            // the conference if it was ever fully joined to the conference
            var value = {connected : true};
            OpenAjax.hub.publish(coweb.END, value);
        }
        // do a logout to disconnect from the session
        this.leaveConference();
        // let listener shutdown gracefully
        this._listener.destroy();
        // cleanup the client
        this._bridge.destroy();
        // cleanup references
        this._listener = null;
        this._prepParams = null;
        this._lastPrep = null;
        this._bridge = null;
        dojo.disconnect(this._disconnectTok);
        this._disconnectTok = null;
    };

    /**
     * Gets if the session was initialized for debugging or not.
     *
     * @return True if debugging, false if not
     */
    bayeux.prototype.isDebug = function() {
        return this._debug;
    },

    
    /**
     * Gets a reference to the parameters last given to prepareConference().
     * Includes any values automatically filled in for missing attributes.
     */
    bayeux.prototype.getConferenceParams = function() {
        return this._lastPrep;
    },

    /**
     * Called by an application to leave a session or abort joining it.
     */    
    bayeux.prototype.leaveConference = function() {
        var state = this._bridge.getState();
        if(state == this._bridge.UPDATED) {
            // broadcast a final hub event indicating the client is now leaving
            // the conference
            var value = {connected : true};
            OpenAjax.hub.publish(coweb.END, value);
        } else {
            OpenAjax.hub.publish(coweb.BUSY, 'aborting');
            this._prepParams = null;
        }
        
        // instant success
        def = new dojo.Deferred();
        def.callback();
        // do the session logout
        this._bridge.logout();
        return def;
    },

    /**
     * Called by an app to optionally authenticate with the server.
     */
    bayeux.prototype.login = function(username, password) {
        if(this._bridge.getState() != this._bridge.IDLE) {
            throw new Error('login() not valid in current state');
        }
        var args = {
            url : this._loginUrl,
            postData: dojo.toJson({username : username, password: password})
        };
        return dojo.xhrPost(args);
    },

    /**
     * Called by an app to optionally logout from the server.
     */
    bayeux.prototype.logout = function() {
        // leave the session
        this.leaveConference();
        // contact credential server to remove creds
        return dojo.xhrGet({url : this._logoutUrl});
    },

    /**
     * Called by an app to prepare a session.
     */
    bayeux.prototype.prepareConference = function(params) {
        if(this._bridge.getState() != this._bridge.IDLE) {
            throw new Error('prepareConference() not valid in current state');
        }

        // get url params in case we need them
        var url_params = dojo.queryToObject(window.location.search.substring(1));
        
        if(params.key === undefined) {
            // app didn't specify explicit key
            if(url_params.cowebkey !== undefined) {
                // use the key from the url
                params.key = url_params.cowebkey;
            } else {
                // default to use the full url minus the hash value
                params.key = decodeURI(window.location.host + window.location.pathname + window.location.search);
            }            
        }
        
        if(params.autoUpdate === undefined) {
            // backward compat, auto update by default
            params.autoUpdate = true;
        }

        // create a deferred result and hang onto its ref as part of the params
        this._prepParams = dojo.clone(params);
        this._prepParams.deferred = new dojo.Deferred();
        
        // store second copy of prep info for public access to avoid meddling
        this._lastPrep = {};
        dojo.mixin(this._lastPrep, this._prepParams);
        delete this._lastPrep.deferred;

        // only do actual prep if the session has reported it is ready
        // try to prepare conference
        this._bridge.prepareConference(this._prepParams.key, 
            this._prepParams.collab)
            .addCallback(dojo.hitch(this, '_onPrepared'))
            .addErrback(dojo.hitch(this, '_onPrepareError'));        

        // show the busy dialog for the prepare phase
        OpenAjax.hub.publish(coweb.BUSY, 'preparing');

        // return deferred result
        return this._prepParams.deferred;
    },
    
    bayeux.prototype._onPrepared = function(params) {
        // store response
        this._prepParams.response = dojo.clone(params);
        // pull out the deferred result
        var def = this._prepParams.deferred;
        // watch for errors during prep callback as indicators of failure to
        // configure an application
        def.addErrback(dojo.hitch(this, '_onAppPrepareError'));
        // if auto joining, build next def and pass with params
        if(this._prepParams.autoJoin) {
            params.nextDef = new dojo.Deferred();
        }
        // inform all deferred listeners about success
        try {
            def.callback(params);
        } catch(e) {
            // in debug mode, the exception bubbles and we should invoke
            // the error handler manually
            this._onAppPrepareError(e);
            return;
        }
        if(this._prepParams.autoJoin) {
            this.joinConference(params.nextDef);
        }
    },

    bayeux.prototype._onPrepareError = function(err) {
        // notify busy dialog of error; no disconnect at this stage because 
        // we're not using cometd yet
        OpenAjax.hub.publish(coweb.BUSY, err.message);

        // invoke prepare error callback
        var def = this._prepParams.deferred;
        this._prepParams = null;
        def.errback(err);
    },

    /**
     * Called by an app to join a session.
     */
    bayeux.prototype.joinConference = function(nextDef) {
        if(this._bridge.getState() != this._bridge.PREPARED) {
            throw new Error('joinConference() not valid in current state');
        }

        // switch busy dialog to joining state
        OpenAjax.hub.publish(coweb.BUSY, 'joining');

        // new deferred for join success / failure
        this._prepParams.deferred = nextDef || new dojo.Deferred();

        this._bridge.joinConference()
            .addCallback(dojo.hitch(this, '_onJoined'))
            .addErrback(dojo.hitch(this, '_onJoinError'));
        
        return this._prepParams.deferred;
    },

    bayeux.prototype._onJoined = function() {
        // pull out the deferred result
        var def = this._prepParams.deferred;
        // watch for errors during prep callback as indicators of failure to
        // configure an application
        def.addErrback(dojo.hitch(this, '_onAppPrepareError'));
        var params = {};
        // if auto updating, build next def and pass with params
        if(this._prepParams.autoUpdate) {
            params.nextDef = new dojo.Deferred();
        }
        // inform all deferred listeners about success
        try {
            def.callback(params);
        } catch(e) {
            // in debug mode, the exception bubbles and we should invoke
            // the error handler manually
            this._onAppPrepareError(e);
            return;
        }
        if(this._prepParams.autoUpdate) {
            this.updateInConference(params.nextDef);
        }
    },

    bayeux.prototype._onJoinError = function(err) {
        // nothing to do, session controller goes back to idle
        var def = this._prepParams.deferred;
        this._prepParams = null;
        def.errback(err);
    },
    
    /**
     * Called by an application to update its state in a session.
     */
    bayeux.prototype.updateInConference = function(nextDef) {
        if(this._bridge.getState() != this._bridge.JOINED) {
            throw new Error('updateInConference() not valid in current state');
        }
        // show the busy dialog for the update phase
        OpenAjax.hub.publish(coweb.BUSY, 'updating');

        // new deferred for join success / failure
        this._prepParams.deferred = nextDef || new dojo.Deferred();
        
        this._bridge.updateInConference()
            .addCallback(dojo.hitch(this, '_onUpdated'))
            .addErrback(dojo.hitch(this, '_onUpdateError'));
        
        return this._prepParams.deferred;
    },

    bayeux.prototype._onUpdated = function() {
        var prepParams = this._prepParams;
        this._prepParams = null;
        // notify session interface of update success
        var def = prepParams.deferred;
        // notify of update success
        def.callback();

        // session is now updated in conference
        OpenAjax.hub.publish(coweb.BUSY, 'ready');
        var hc = this._bridge.getHubController();
        // initialize the hub listener with the client reference now that 
        // the conference is fully established
        this._listener.start(hc, prepParams.collab);

        // broadcast a final hub event indicating the client is now fully in
        // the conference
        var roster = hc.getInitialRoster();
        var value = {
            username : prepParams.response.username,
            site : this._listener.getSiteID(),
            roster : roster
        };
        OpenAjax.hub.publish(coweb.READY, value);
    },

    bayeux.prototype._onUpdateError = function(err) {
        // nothing to do yet, session goes back to idle
        var def = this._prepParams.deferred;
        this._prepParams = null;
        def.errback(err);
    },

    bayeux.prototype._onDisconnected = function(state, tag) {
        if(tag && !this._destroying) {
            // show an error in the busy dialog
            OpenAjax.hub.publish(coweb.BUSY, tag);
        }
        if(state == this._bridge.UPDATED) {
            // broadcast a final hub event indicating the client is now leaving
            // the conference if it was ever fully joined to the conference
            var value = {connected : false};
            OpenAjax.hub.publish(coweb.END, value);
        }
        // stop the hub listener from performing further actions
        this._listener.stop();
        
        // keep prep info if a deferred is still waiting for notification
        if(this._prepParams && !this._prepParams.deferred) {
            this._prepParams = null;
        }
    },
    
    /**
     * Called by JS when an exception occurs in the application's successful
     * conference prepare callback. Disconnects and notifies busy.
     */
    bayeux.prototype._onAppPrepareError = function(err) {
        console.error(err.message);
        // force a logout to get back to the idle state
        this.leaveConference();
        // notify about error state
        OpenAjax.hub.publish(coweb.BUSY, 'bad-application-state');
    };

    return bayeux;
});
