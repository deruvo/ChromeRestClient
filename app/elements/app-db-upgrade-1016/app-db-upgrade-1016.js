(function() {
'use strict';
/* global PouchDB */
/**
 * This element is to upgrade the database to new specification required for future changes.
 *
 * First at all it will keep old data intact. It creates new datastores and attept to copy
 * data to new location. It will not destroy old databases after transition.
 *
 * This script will ba also used to indert import files from a legacy system.
 */
Polymer({
  is: 'app-db-upgrade-1016',

  ready: function() {
    this.checkIsUpgraded()
    .then((isDone) => {
      if (isDone) {
        return;
      }
      return this.beforeUpgrade()
      .then(() => this.initUpgrade());
    })
    .then(() => this.setStatusUpgraded())
    .then(() => {
      var msg = 'Databse schema upgrade finished with great success!';
      msg += ' And few nights working at home..';
      console.info(msg);
    })
    .catch((e) => {
      var msg = 'Database upgrade error. Please, file an issue report at ';
      msg += 'https://github.com/jarrodek/ChromeRestClient/issues';
      console.error(msg);
      console.error(e);
    });
  },

  // Clean up databases
  beforeUpgrade: function() {
    return Promise.all([
      new PouchDB('history-data').destroy(),
      new PouchDB('saved-requests').destroy(),
      new PouchDB('legacy-projects').destroy(),
      new PouchDB('history-requests').destroy(),
      new PouchDB('external-requests').destroy(),
      new PouchDB('arc-cookies').destroy(),
      new PouchDB('auth-data').destroy()
    ]);
  },

  checkIsUpgraded: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get({'upgrades': []}, (data) => {
        if (data.upgrades.indexOf('102016') !== -1) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  },

  setStatusUpgraded: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get({'upgrades': []}, (data) => {
        if (data.upgrades.indexOf('102016') === -1) {
          data.upgrades.push('102016');
          chrome.storage.local.set(data, () => {
            resolve();
          });
        }
      });
    });
  },

  initUpgrade: function() {
    return arc.app.importer.prepareExport()
    .then((data) => this.processPackage(data))
    .then(() => this.copyCookies());
  },

  processPackage: function(data) {
    this.fire('upgrade-102016', {
      message: 'Initializing upgrade'
    });
    // In new structure projects do not have a refference to request ids.
    // It's the other way around. It's a bad pattern for object stores but
    // it must suffice for now.
    var projects = data.projects;
    // Requests are de-centralized. History is placed in it's own store, saved the same.
    // Also HAR data is stored in it's own store where each HAR objects is another data object.
    var requests = data.requests;

    var parsedRequests;
    var parsedProjects;
    this.prepareRequestsArrays(requests)
    .then((result) => {
      parsedRequests = result;
      return this._processProjects(projects);
    })
    .then((result) => {
      parsedProjects = result;
      return this._insertLegacyProjects(result);
    })
    .then((inserts) => {
      parsedProjects = parsedProjects.map((item, i) => {
        item.insertId = inserts[i].id;
        return item;
      });
    })
    .then(() => this._assignProjects(parsedRequests, parsedProjects))
    .then(() => this._insertSavedRequests(parsedRequests.saved))
    .then(() => this._insertHistorydRequests(parsedRequests.history))
    .then(() => this._insertDrivedRequests(parsedRequests.external))
    .then(() => this._insertHistoryData(parsedRequests.har));
  },
  // Returns an array of saved, history and har objects.
  prepareRequestsArrays: function(requests) {
    this.fire('upgrade-102016', {
      message: 'Processing requests data'
    });
    return new Promise((resolve, reject) => {
      this._parsePartRequests(requests, resolve, reject);
    });
  },
  /**
   * To give a browser a chance to enter to the main loop the work is split to chunks.
   * With this approach the app will not block main thread and will not show "ANR" screen.
   *
   *
   */
  _parsePartRequests: function(requests, resolve, reject, saved, history, har, external) {
    saved = saved || [];
    history = history || [];
    har = har || [];
    external = external || [];
    if (requests.length === 0) {
      resolve({
        saved: saved,
        history: history,
        har: har,
        external: external
      });
      return;
    }
    var len = Math.min(requests.length, 200);
    // Up to 200 loop iteration at once.
    // Then the function return and release main loop.
    for (let i = 0; i < len; i++) {
      let item = requests[i];
      if (item.type === 'history') {
        let result = this._parseHistoryItem(item);
        history.push({
          origin: result.originId,
          request: result.request
        });
        har = har.concat(result.historyData);
      } else if (item.type === 'saved') {
        let result = this._parseSavedItem(item);
        saved.push({
          origin: result.originId,
          request: result.request
        });
        har = har.concat(result.historyData);
      } else if (item.type === 'drive') {
        let result = this._parseDriveItem(item);
        external.push({
          origin: result.originId,
          request: result.request
        });
        har = har.concat(result.historyData);
      }
    }
    requests.splice(0, len);
    this.async(() => {
      this._parsePartRequests(requests, resolve, reject, saved, history, har, external);
    }, 1);
  },
  /**
   * Parser for the history request
   * ## The history request object.
   * The request object is consisted with following properties:
   * - _id: url + '/' + method + '/' + date
   * - url: String
   * - method: String
   * - headers: String
   * - payload: String
   * - created: time
   * @return {Object|null}
   */
  _parseHistoryItem: function(item) {
    var obj = {
      _id: encodeURIComponent(item.url) + '/' + item.method + '/' + item.updateTime,
      method: item.method,
      url: item.url
    };
    // payload and headers
    var entries = item.har.entries;
    var entry = entries[entries.length - 1];
    if (entry) {
      let harRequest = entry.request;
      obj.headers = this._parseHarHeders(harRequest.headers);
      obj.payload = harRequest.postData.text;
      let t = new Date(entry.startedDateTime).getTime();
      if (t !== t) {
        t = Date.now();
      }
      obj.created = t;
    }
    return {
      originId: item.id,
      historyData: this.processHar(item.har),
      request: obj
    };
  },
  /**
   * Parser for the saved request
   * ## The request object.
   * The request object is consisted with following properties:
   * - _id: name + '/' + url + '/' + method
   * - name: String
   * - url: String
   * - method: String
   * - headers: String
   * - payload: String
   * - created: time
   * - legacyProject: 0
   * @return {Object|null}
   */
  _parseSavedItem: function(item) {
    var obj = {
      _id: encodeURIComponent(item.name) + '/' + encodeURIComponent(item.url) + '/' + item.method,
      name: item.name,
      method: item.method,
      url: item.url
    };
    // payload and headers
    var harIndex = item.referenceEntry || 0;
    var entries = item.har.entries;
    var entry;
    if (harIndex || harIndex === 0) {
      entry = entries[harIndex];
    } else {
      entry = entries[0];
    }
    if (entry) {
      let harRequest = entry.request;
      obj.headers = this._parseHarHeders(harRequest.headers);
      obj.payload = harRequest.postData.text;
      let t = new Date(entry.startedDateTime).getTime();
      if (t !== t) {
        t = Date.now();
      }
      obj.created = t;
    }
    return {
      originId: item.id,
      historyData: this.processHar(item.har),
      request: obj
    };
  },
  // The same as saved but with drive id
  _parseDriveItem: function(item) {
    var result = this._parseSavedItem(item);
    result.request.driveId = item.driveId;
    result.request.type = 'google-drive';
    return result;
  },
  // @returns {!String}
  _parseHarHeders: function(headersArray) {
    if (!headersArray || !headersArray.length) {
      return '';
    }
    return headersArray.map((item) => {
      return item.name + ': ' + item.value;
    }).join('\n');
  },

  _processProjects: function(projects) {
    this.fire('upgrade-102016', {
      message: 'Processing projects data'
    });
    if (!projects || !projects.length) {
      return [];
    }
    var list = projects.map((item) => {
      if (!item.requestIds || !item.requestIds.length) {
        return null;
      }
      return {
        updateData: item.requestIds,
        legacyProject: {
          _id: this.$.uuid.generate(),
          name: item.name,
          order: item.order,
          updated: item.updateTime,
          created: item.created
        }
      };
    });
    return list.filter((i) => i !== null);
  },
  /**
   * The history data object.
   * - _id: autogenerated.
   * - headers
   * - payload
   * - url
   * - method
   * - response: Object
   *   - statusCode
   *   - statusText
   *   - headers
   *   - payload
   * - timings
   * - created: int!
   */
  processHar: function(har) {
    if (!har || !har.entries || !har.entries.length) {
      return null;
    }
    return har.entries.map((item) => {
      let req = item.request;
      let res = item.response;
      let cd = new Date(item.startedDateTime).getTime();
      if (cd !== cd) {
        cd = Date.now();
      }
      return {
        _id: this.$.uuid.generate(),
        headers: this._parseHarHeders(req.headers),
        payload: req.postData.text,
        url: req.url,
        method: req.method,
        timings: item.timings,
        totalTime: item.time,
        created: cd,
        response: {
          statusCode: res.status,
          statusText: res.statusText,
          headers: this._parseHarHeders(res.headers),
          payload: res.content.text
        }
      };
    });
  },

  _insertLegacyProjects: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting projects (' + data.length + ')'
    });
    var db = new PouchDB('legacy-projects');
    return db.bulkDocs(data.map((i) => i.legacyProject));
  },

  _insertSavedRequests: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting saved requests (' + data.length + ')'
    });
    var db = new PouchDB('saved-requests');
    return db.bulkDocs(data.map((i) => i.request));
  },

  _insertHistorydRequests: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting history (' + data.length + ')'
    });
    var db = new PouchDB('history-requests');
    return db.bulkDocs(data.map((i) => i.request));
  },

  _insertDrivedRequests: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting external data (' + data.length + ')'
    });
    var db = new PouchDB('external-requests');
    return db.bulkDocs(data.map((i) => i.request));
  },

  _insertHistoryData: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting history (HAR) data (' + data.length + ')'
    });
    var db = new PouchDB('history-data');
    return db.bulkDocs(data);
  },

  _insertCookies: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting cookies (' + data.length + ')'
    });
    var db = new PouchDB('arc-cookies');
    return db.bulkDocs(data);
  },

  _insertAuthData: function(data) {
    if (!data || !data.length) {
      return Promise.resolve();
    }
    this.fire('upgrade-102016', {
      message: 'Inserting auth data (' + data.length + ')'
    });
    var db = new PouchDB('auth-data');
    return db.bulkDocs(data);
  },

  _assignProjects: function(data, projects) {
    if (!projects || !projects.length) {
      return;
    }
    this.fire('upgrade-102016', {
      message: 'Associating legacy projects with requests'
    });
    data.saved = data.saved || [];
    var savedLen = data.saved.length;
    for (let i = 0, pLen = projects.length; i < pLen; i++) {
      let project = projects[i];
      if (!project || !project.insertId) {
        continue;
      }
      let newProjectId = project.insertId;
      for (let j = 0, rLen = project.updateData.length; j < rLen; j++) {
        let rId = project.updateData[j];
        for (let k = 0; k < savedLen; k++) {
          if (data.saved[k].origin === rId) {
            if (!data.saved[k].legacyProject) {
              data.saved[k].request.legacyProject = newProjectId;
              break;
            }
          }
        }
      }
    }
  },

  copyCookies: function() {
    return new Promise((resolve, reject) => {
      var db;
      var error;
      arc.app.db.idb.open()
      .then((_db) => {
        db = _db;
        return db.cookies.toArray();
      })
      .then((arr) => {
        if (!arr || !arr.length) {
          return null;
        }
        return arr.map((i) => {
          i = Object.assign({}, i);
          i.domain = i._domain;
          i.expires = i._expires;
          i.maxAge = i._maxAge;
          delete i._domain;
          delete i._expires;
          delete i._maxAge;
          i._id = i.domain + '/' + encodeURIComponent(i.name) + '/' + encodeURIComponent(i.path);
          return i;
        });
      })
      .then((toInsert) => this._insertCookies(toInsert))
      .catch((err) => {
        error = err;
      })
      .finally(function() {
        db.close();
        // Escape Dexie promise system.
        if (error) {
          return reject(); // <- like building node modules using promises... terrible
          // I mean, really, people, learn to use promises!
          // And learn how should it be used. Def not like Dexie does.
        }
        resolve();
      });
    });
  },

  copyAuthData: function() {
    return new Promise((resolve, reject) => {
      var db;
      var error;
      arc.app.db.idb.open()
      .then((_db) => {
        db = _db;
        return db.basicAuth.toArray();
      })
      .then((arr) => {
        if (!arr || !arr.length) {
          return null;
        }
        return arr.map((i) => {
          i = Object.assign({}, i);
          i._id = i.type + '/' + encodeURIComponent(i.url);
          return i;
        });
      })
      .then((toInsert) => this._insertAuthData(toInsert))
      .catch((err) => {
        error = err;
      })
      .finally(function() {
        db.close();
        // Escape Dexie promise system.
        if (error) {
          return reject();
        }
        resolve();
      });
    });
  }
});
})();