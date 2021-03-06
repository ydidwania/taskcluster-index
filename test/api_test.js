suite('API', () => {
  var assert      = require('assert');
  var debug       = require('debug')('index:test:api_test');
  var helper      = require('./helper');
  var slugid      = require('slugid');
  var _           = require('lodash');
  var taskcluster = require('taskcluster-client');
  var request     = require('superagent');

  // Artifact names that we have assigned scopes to testing credentials for.
  var publicArtifactName = 'public/dummy-test-provisioner.log';
  var privateArtifactName = 'private/dummy-test-provisioner.log';

  // Create expiration
  var expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + 25);

  test('insert (and rank)', async function() {
    var myns    = slugid.v4();
    var taskId  = slugid.v4();
    var taskId2  = slugid.v4();
    await helper.index.insertTask(myns + '.my-task', {
      taskId:     taskId,
      rank:       41,
      data:       {hello: 'world'},
      expires:    expiry.toJSON(),
    });
    let result = await helper.index.findTask(myns + '.my-task');
    assert(result.taskId === taskId, 'Wrong taskId');

    await helper.index.insertTask(myns + '.my-task', {
      taskId:     taskId2,
      rank:       42,
      data:       {hello: 'world - again'},
      expires:    expiry.toJSON(),
    });
    result = await helper.index.findTask(myns + '.my-task');
    assert(result.taskId === taskId2, 'Wrong taskId');
  });

  test('find (non-existing)', async function() {
    var ns = slugid.v4() + '.' + slugid.v4();
    try {
      await helper.index.findTask(ns);
    } catch (err) {
      assert(err.statusCode === 404, 'Should have returned 404');
      return;
    }
    assert(false, 'This shouldn\'t have worked');
  });

  suite('listing things', function() {
    var assume = require('assume');
    suiteSetup(async function() {
      const paths = [
        'abc', 'abc.def', 'abc.def2',
        'bbc',
        'bbc.def',
        'cbc',
        'cbc.def',
        'dbc.def2',
      ];

      const expired_paths = [
        'pqr', 'pqr.stu', 'pqr.stu2',
        'ppt', 'ppt.stu',    
      ];

      const expires = expiry.toJSON();
      var expired = new Date();
      expired.setDate(expired.getDate() - 1);
      const new_expires = expired.toJSON();
      const taskId = slugid.v4();

      for (let path of paths) {
        await helper.index.insertTask(path, {taskId, rank: 13, data: {}, expires});
      }

      for (let path of expired_paths) {
        await helper.index.insertTask(path, {taskId, rank: 13, data: {}, expires: new_expires});
      }
    });

    var testValidNamespaces = function(list, VALID_PREFIXES=['abc', 'bbc', 'cbc']) {
      let namespaces = [];
      const INVALID_PREFIXES = ['pqr', 'ppt'];
      list.forEach(function(ns) {
        namespaces.push(ns.namespace);
        assert(ns.namespace.indexOf('.') === -1, 'shouldn\'t have any dots');
      });

      VALID_PREFIXES.forEach(function(prefix) {
        assume(namespaces).contains(prefix);
      });

      INVALID_PREFIXES.forEach(function(prefix) {
        assume(namespaces).not.contains(prefix);
      });
    };

    test('list top-level namespaces', async function() {
      let result = await helper.index.listNamespaces('', {});
      testValidNamespaces(result.namespaces, ['abc', 'bbc', 'cbc', 'dbc']);
    });

    test('list top-level namespaces with continuation', async function() {
      let opts = {limit: 1};
      let results = [];
      
      while (1) {
        let result = await helper.index.listNamespaces('', opts);
        results = results.concat(result.namespaces);
        if (!result.continuationToken) {
          break;
        }
        opts.continuationToken = result.continuationToken;
      }
      assert.equal(results.length, 6);
      testValidNamespaces(results, ['abc', 'bbc', 'cbc', 'dbc']);
    });

    test('list top-level namespaces (without auth)', async function() {
      var index = new helper.Index();
      let result = await index.listNamespaces('', {});
      testValidNamespaces(result.namespaces, ['abc', 'bbc', 'cbc', 'dbc']);
    });

    test('list top-level tasks', async function() {
      let result = await helper.index.listTasks('', {});
      testValidNamespaces(result.tasks);
    });

    test('list top-level tasks with continuation', async function() {
      let opts = {limit: 1};
      let results = [];

      while (1) {
        let result = await helper.index.listTasks('', opts);
        results = results.concat(result.tasks);
        if (!result.continuationToken) {
          break;
        }
        opts.continuationToken = result.continuationToken;
      }

      assert.equal(results.length, 3);
      testValidNamespaces(results);
    });

    test('list top-level tasks (without auth)', async function() {
      var index = new helper.Index();
      let result = await index.listTasks('', {});
      testValidNamespaces(result.tasks);
    });

    test('list top-level tasks', async function() {
      let result = await helper.index.listTasks('', {});
      testValidNamespaces(result.tasks);
    });

    test('findTask throws 404 for expired tasks', async function() {
      var myns    = slugid.v4();
      var taskId  = slugid.v4();
      var expired = new Date();
      expired.setDate(expired.getDate() - 1);
      const new_expires = expired.toJSON();

      await helper.index.insertTask(myns + '.my-task', {
        taskId:     taskId,
        rank:       41,
        data:       {hello: 'world'},
        expires:    new_expires,
      });

      try {
        await helper.index.findTask(myns + '.my-task');
      } catch (err) {
        assert(err.statusCode === 404, 'Should have returned 404');
        return;
      }
    });
  });

  test('access public artifact', async function() {
    let taskId = slugid.nice();
    debug('### Insert task into index');
    await  helper.index.insertTask('my.name.space', {
      taskId:     taskId,
      rank:       41,
      data:       {hello: 'world'},
      expires:    taskcluster.fromNowJSON('24 hours'),
    });

    debug('### Download public artifact using index');
    var url = helper.index.buildUrl(
      helper.index.findArtifactFromTask,
      'my.name.space',
      'public/abc.zip'
    );
    var res = await request.get(url).redirects(0).catch(function(err) {
      return err.response;
    });
    assert.equal(res.statusCode, 303, 'Expected 303 redirect');
    assert.equal(res.headers.location, `https://queue.taskcluster.net/v1/task/${taskId}/artifacts/public%2Fabc.zip`);
  });

  test('access private artifact (with * scope)', async function() {
    let taskId = slugid.nice();
    debug('### Insert task into index');
    await  helper.index.insertTask('my.name.space', {
      taskId:     taskId,
      rank:       41,
      data:       {hello: 'world'},
      expires:    taskcluster.fromNowJSON('24 hours'),
    });

    debug('### Download private artifact using index');
    var url = helper.index.buildSignedUrl(
      helper.index.findArtifactFromTask,
      'my.name.space',
      'not-public/abc.zip'
    );
    var res = await request.get(url).redirects(0).catch(function(err) {
      return err.response;
    });
    assert.equal(res.statusCode, 303, 'Expected 303 redirect');
    let location = res.headers.location.replace(/bewit=.*/, 'bewit=xyz');
    assert.equal(location, `https://queue.taskcluster.net/v1/task/${taskId}/artifacts/not-public%2Fabc.zip?bewit=xyz`);
  });

  test('access private artifact (with no scopes)', async function() {
    let taskId = slugid.nice();
    debug('### Insert task into index');
    await  helper.index.insertTask('my.name.space', {
      taskId:     taskId,
      rank:       41,
      data:       {hello: 'world'},
      expires:    taskcluster.fromNowJSON('24 hours'),
    });

    debug('### Download private artifact using index with no scopes');
    var index = new taskcluster.Index({
      baseUrl: helper.baseUrl,
      credentials: {
        clientId: 'public-only-client',
        accessToken: 'none',
      },
    });
    var url = index.buildSignedUrl(
      helper.index.findArtifactFromTask,
      'my.name.space',
      'not-public/abc.zip'
    );
    var res = await request.get(url).redirects(0).catch(function(err) {
      return err.response;
    });
    assert.equal(res.statusCode, 403, 'Expected 403 Forbidden');
  });
});
