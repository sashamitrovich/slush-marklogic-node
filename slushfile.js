/* jshint node: true */

'use strict';

var gulp = require('gulp'),
  FetchStream = require('fetch').FetchStream,
  fs = require('fs'),
  inquirer = require('inquirer'),
  install = require('gulp-install'),
  q = require('q'),
  rename = require('gulp-rename'),
  replace = require('gulp-replace'),
  pkgSettings = require('./package.json'),
  spawn = require('child_process').spawn,
  uuid = require('node-uuid'),
  win32 = process.platform === 'win32';

/* jshint ignore:start */
var colors = require('colors'),
  _ = require('underscore.string');
/* jshint ignore:end */

var npmVersion = null;

var settings = {};

var encoding = {
  encoding: 'utf8'
};

var skipBinary = {
  skipBinary: true
};

function printVersionWarning() {
  if (npmVersion && npmVersion !== pkgSettings.version.trim()) {
    process.stdout.write('\n------------------------------------\n'.red);
    process.stdout.write('Slush MarkLogic Node is out of date:\n'.bold.yellow);
    process.stdout.write((' * Locally installed version: ' + pkgSettings.version + '\n').yellow);
    process.stdout.write((' * Latest version: ' + npmVersion + '\n').yellow);
    process.stdout.write(' * Run '.yellow + 'npm install -g slush-marklogic-node'.bold + ' to update\n'.yellow);
    process.stdout.write('------------------------------------\n\n'.red);
    npmVersion = null;
  }
}

function checkLatestVersion() {
  var latestVersion = q.defer();

  try {
    console.log('checking for latest version');
    /* jshint camelcase:false */
    var proxy = process.env.PROXY || process.env.http_proxy || null;
    /* jshint camelcase:true */
    var request = require('request');
    request({
      url: 'http://registry.npmjs.org/slush-marklogic-node/latest',
      proxy: proxy
    }, function(err, res, body) {
      try {
        npmVersion = JSON.parse(body).version;
      } catch (e) {}
      latestVersion.resolve();
    });
  } catch (e) {
    latestVersion.resolve();
  }

  return latestVersion.promise;
}

function isFlag(arg) {
  return (arg.indexOf('=') > -1);
}

function processInput() {
  var inputs = {
    appType: 'rest',
    branch: 'master'
  };
  gulp.args.forEach(function(arg) {
    if (isFlag(arg)) {
      var splits = arg.split('=');
      var flag = splits[0];
      var value = splits[1];
      if (flag === 'appType') {
        inputs.appType = value;
      } else if (flag === 'branch') {
        inputs.branch = value;
      } else {
        var message = arg + '\n is not a supported flag and has been ignored. You can specify appType=<appType> to specify Roxy appType or branch=<branch> to specify a Roxy branch\n';
        process.stdout.write(message.red);
      }
    } else {
      inputs.appName = arg;
    }
  });
  return inputs;
}

function getNameProposal() {
  var path = require('path');
  try {
    return require(path.join(process.cwd(), 'package.json')).name;
  } catch (e) {
    return path.basename(process.cwd());
  }
}

// Download the Roxy ml script from GitHub
function getRoxyScript(appName, mlVersion, appType, branch) {

  var d = q.defer(),
    out;

  var scriptName = (win32 ? '' : './') + 'ml' + (win32 ? '.bat' : '');

  console.log('Retrieving Roxy script');
  out = fs.createWriteStream(scriptName);
  var stream = new FetchStream('https://github.com/marklogic/roxy/raw/' + branch + '/' + scriptName);
  stream.pipe(out);
  stream.on('end', function() {
    console.log('Got Roxy script');
    out.end();

    fs.chmod(scriptName, '755', function(err) {
      if (err) {
        console.log(err);
        d.reject(err);
      } else {
        console.log('chmod done; appName=' + appName + '; mlVersion=' + mlVersion + '; appType=' + appType + '; branch=' + branch);
        d.resolve({
          'script': scriptName,
          'app': appName,
          'mlVersion': mlVersion,
          'appType': appType,
          'branch': branch
        });
      }
    });
  });

  return d.promise;
}

// Run the Roxy "ml new" command for the new project
function runRoxy(config) {
  var scriptName = config.script,
    appName = config.app,
    mlVersion = config.mlVersion,
    appType = config.appType,
    branch = config.branch;

  var d = q.defer();

  var args = [
    'new',
    appName,
    '--server-version=' + mlVersion,
    '--app-type=' + appType,
    '--branch=' + branch
  ];

  console.log('Spawning Roxy new command: ' + scriptName + ' ' + args.join(' '));
  var child = spawn(scriptName, args, {
    stdio: [
      0, // Use parents stdin for child
      'pipe', // Pipe child's stdout to parent (default)
      'pipe' // Pipe child's stderr to parent (default)
    ]
  });

  child.on('close', function() {
    console.log('done running ml new');
    d.resolve('done');
  });

  child.stdout.on('data', function(data) {
    console.log('' + data);
  });

  child.stderr.on('data', function(data) {
    console.log('' + data);
  });

  return d.promise;
}

// Make some changes to Roxy's deploy/build.properties file for the out-of-the-box application
function configRoxy() {
  console.log('Configuring Roxy');

  try {
    var properties = fs.readFileSync('deploy/build.properties', encoding);

    // Set the authentication-method property to digestbasic
    properties = properties.replace(/^authentication\-method=digest/m, 'authentication-method=digestbasic');

    // Capture appuser-password from Roxy properties for later use
    var passwordMatch = /^appuser\-password=(.*)$/m;
    var matches = passwordMatch.exec(properties);
    settings.appuserPassword = matches[1];

    // Bypass bug in Roxy causing {, } and \ in pwd to get mangled
    if (settings.appuserPassword.match(/[\{\}\\]/g)) {
      settings.appuserPassword = settings.appuserPassword.replace(/[\{\}\\]/g, '');
      properties = properties.replace(passwordMatch, 'appuser-password=' + settings.appuserPassword);
    }

    fs.writeFileSync('deploy/build.properties', properties);
  } catch (e) {
    console.log('failed to update properties: ' + e.message);
  }

  try {
    var localProperties = '#################################################################\n' +
      '# This file contains overrides to values in build.properties\n' +
      '# These only affect your local environment and should not be checked in\n' +
      '#################################################################\n' +
      '\n' +
      'server-version=' + settings.mlVersion + '\n' +
      '\n' +
      '#\n' +
      '# The ports used by your application\n' +
      '#\n' +
      'app-port=' + settings.appPort + '\n';
    if (settings.mlVersion < 8) {
      localProperties += 'xcc-port=' + settings.xccPort + '\n';
    } else {
      localProperties += '# Taking advantage of not needing a XCC Port for ML8\n' +
        'xcc-port=${app-port}\n' +
        'install-xcc=false\n';
    }

    localProperties += '\n' +
      '#\n' +
      '# the uris or IP addresses of your servers\n' +
      '# WARNING: if you are running these scripts on WINDOWS you may need to change localhost to 127.0.0.1\n' +
      '# There have been reported issues with dns resolution when localhost wasn\'t in the hosts file.\n' +
      '#\n' +
      'local-server=' + settings.marklogicHost + '\n' +
      'content-forests-per-host=3\n' +
      '\n' +
      '#\n' +
      '# Admin username/password that will exist on the local/dev/prod servers\n' +
      '#\n' +
      'user=' + settings.marklogicAdminUser + '\n' +
      'password=' + settings.marklogicAdminPass + '\n';

    fs.writeFileSync('deploy/local.properties', localProperties, encoding);
  } catch (e) {
    console.log('failed to write roxy local.properties');
  }

  try {
    var foo = fs.readFileSync('deploy/ml-config.xml', encoding);

    // add an index for the default content
    foo = foo.replace(/^\s*<range-element-indexes>/m,
      '      <range-element-indexes>\n' +
      '        <range-element-index>\n' +
      '          <scalar-type>string</scalar-type>\n' +
      '          <namespace-uri/>\n' +
      '          <localname>eyeColor</localname>\n' +
      '          <collation>http://marklogic.com/collation/codepoint</collation>\n' +
      '          <range-value-positions>false</range-value-positions>\n' +
      '        </range-element-index>\n');

    // add a geospatial index for the default content
    foo = foo.replace(/^\s*<geospatial-element-pair-indexes>/m,
      '      <geospatial-element-pair-indexes>\n' +
      '        <geospatial-element-pair-index>\n' +
      '          <parent-namespace-uri/>\n' +
      '          <parent-localname>location</parent-localname>\n' +
      '          <latitude-namespace-uri/>\n' +
      '          <latitude-localname>latitude</latitude-localname>\n' +
      '          <longitude-namespace-uri/>\n' +
      '          <longitude-localname>longitude</longitude-localname>\n' +
      '          <coordinate-system>wgs84</coordinate-system>\n' +
      '          <range-value-positions>false</range-value-positions>\n' +
      '        </geospatial-element-pair-index>\n');

    // fix default app-role privileges to match rest-style applications
    foo = foo.replace(/<privileges>[^]*?<\/privileges>/,
      '<privileges>\n' +
      '        <privilege>\n' +
      '          <privilege-name>rest-reader</privilege-name>\n' +
      '        </privilege>\n' +
      '        <!-- remove the rest-writer privilege if read-only access is required -->\n' +
      '        <privilege>\n' +
      '          <privilege-name>rest-writer</privilege-name>\n' +
      '        </privilege>\n' +
      '      </privileges>\n');

    fs.writeFileSync('deploy/ml-config.xml', foo);
  } catch (e) {
    console.log('failed to update configuration: ' + e.message);
  }

}

gulp.task('npmInstall', ['init', 'generateSecret', 'configGulp'], function(done) {
  return gulp.src(['./package.json'])
    .pipe(install({
      args: ['--msvs_version=2013'] // npm install --msvs_version=2013 // node-gyph depends on Visual C++ on Win
    }));
});

gulp.task('default', ['npmInstall'], function(done) {
  return gulp.src(['./bower.json'])
    .pipe(install());
});

gulp.task('generateSecret', ['init'], function(done) {
  try {

    var nodeApp = fs.readFileSync('node-server/node-app.js', encoding);

    //generate new uuid
    var secret = uuid.v4();
    nodeApp = nodeApp.replace(/\bsecret: '\b.*\b'/m, 'secret: \'' + secret + '\'');

    fs.writeFileSync('node-server/node-app.js', nodeApp);
  } catch (e) {
    console.log('failed to update SECRET in node-server/node-app.js: ' + e.message);
  }

  done();
});

gulp.task('configGulp', ['init'], function(done) {

  try {
    var configJSON = {};
    configJSON['app-name'] = settings.appName;
    configJSON['ml-version'] = settings.mlVersion;
    configJSON['ml-host'] = settings.marklogicHost;
    configJSON['ml-admin-user'] = settings.marklogicAdminUser;
    configJSON['ml-admin-pass'] = settings.marklogicAdminPass;
    configJSON['ml-app-user'] = settings.appName + '-user';
    configJSON['ml-app-pass'] = settings.appuserPassword;
    configJSON['ml-http-port'] = settings.appPort;

    if (settings.mlVersion < 8) {
      configJSON['ml-xcc-port'] = settings.xccPort;
    }

    configJSON['node-port'] = settings.nodePort;
    configJSON['guest-access'] = settings.guestAccess;
    configJSON['disallow-updates'] = settings.disallowUpdates;
    configJSON['appusers-only'] = settings.appUsersOnly;

    var configString = JSON.stringify(configJSON, null, 2) + '\n';
    fs.writeFileSync('local.json', configString, encoding);
  } catch (e) {
    console.log('failed to write local.json: ' + e.message);
  }

  done();
});

gulp.task('checkForUpdates', function(done) {
  checkLatestVersion().then(function() {
    printVersionWarning();
    done();
  });
});

gulp.task('init', ['checkForUpdates'], function(done) {
  var clArgs = processInput();
  var appName = clArgs.appName;
  var appType = clArgs.appType;
  var branch = clArgs.branch;

  var prompts = [{
    type: 'list',
    name: 'mlVersion',
    message: 'MarkLogic version?',
    choices: ['8', '7', '6', '5'],
    default: 0
  }, {
    type: 'input',
    name: 'marklogicHost',
    message: 'MarkLogic Host?',
    default: 'localhost'
  }, {
    type: 'input',
    name: 'marklogicAdminUser',
    message: 'MarkLogic Admin User?',
    default: 'admin'
  }, {
    type: 'input',
    name: 'marklogicAdminPass',
    message: 'Note: consider keeping the following blank, ' +
      'you will be asked to enter it at appropriate commands.\n? MarkLogic Admin Password?',
    default: ''
  }, {
    type: 'input',
    name: 'appPort',
    message: 'MarkLogic App/Rest port?',
    default: 8040
  }, {
    type: 'input',
    name: 'xccPort',
    message: 'XCC port?',
    default: 8041,
    when: function(answers) {
      return answers.mlVersion < 8;
    }
  }, {
    type: 'input',
    name: 'nodePort',
    message: 'Node app port?',
    default: 9070
  }, {
    type: 'list',
    name: 'template',
    message: 'Select Template',
    choices: [{
      name: 'default',
      value: 'default'
    }, {
      name: '3-columns',
      value: '3column'
    }, {
      name: 'Dashboard',
      value: 'dashboard'
    }, {
      name: 'Full-screen map',
      value: 'map'
    }, {
      name: 'I don\'t know',
      value: 'unsure'
    }]
  }, {
    type: 'list',
    name: 'theme',
    message: 'What is the main focus?',
    when: function(ans) {
      return ans.template === 'unsure';
    },
    choices: [{
      name: 'Semantics',
      value: '3column'
    }, {
      name: 'Charts',
      value: 'dashboard'
    }, {
      name: 'Map/Graph',
      value: 'map'
    }, {
      name: 'Documents',
      value: '3column'
    }, {
      name: 'Other',
      value: 'default'
    }]
  }, {
    type: 'list',
    name: 'guestAccess',
    message: 'Allow anonymous users to search data?',
    choices: ['false', 'true'],
    default: 0
  }, {
    type: 'list',
    name: 'disallowUpdates',
    message: 'Disallow proxying update requests?',
    choices: ['false', 'true'],
    default: 0
  }, {
    type: 'list',
    name: 'appUsersOnly',
    message: 'Only allow access to users created for this app? Note: disallows admin users.',
    choices: ['false', 'true'],
    default: 0
  }];

  if (typeof appName === 'undefined') {
    prompts.unshift({
      type: 'input',
      name: 'name',
      message: 'Name for the app?',
      default: getNameProposal()
    });
  }

  inquirer.prompt(prompts, function(answers) {
    if (typeof appName === 'undefined') {
      answers.nameDashed = _.slugify(answers.name);
    } else {
      answers.nameDashed = _.slugify(appName);
    }
    settings.mlVersion = answers.mlVersion;
    settings.marklogicHost = answers.marklogicHost;
    settings.marklogicAdminUser = answers.marklogicAdminUser;
    settings.marklogicAdminPass = answers.marklogicAdminPass;
    settings.nodePort = answers.nodePort;
    settings.appPort = answers.appPort;
    settings.xccPort = answers.xccPort || answers.appPort;
    settings.appName = answers.nameDashed;
    settings.guestAccess = answers.guestAccess;
    settings.disallowUpdates = answers.disallowUpdates;
    settings.appUsersOnly = answers.appUsersOnly;

    getRoxyScript(answers.nameDashed, answers.mlVersion, appType, branch)
      .then(runRoxy)
      .then(function() {
          // Copy over the Angular files
          var files = [__dirname + '/app/templates/**'];
          if (answers.theme !== 'default') { // overlay the theme if not the default theme chosen
            files.push(__dirname + '/app/themes/' + (answers.theme || answers.template) + '/**');
          }

          process.chdir('./' + answers.nameDashed);

          configRoxy();

          gulp.src(files)
            .pipe(rename(function(file) {
              // change _foo to .foo
              if (file.basename[0] === '_') {
                file.basename = '.' + file.basename.slice(1);
              }

            }))
            .pipe(replace('@slush-version', pkgSettings.version.trim(), skipBinary))
            .pipe(replace('@sample-app-name', answers.nameDashed, skipBinary))
            .pipe(replace('@sample-app-role', answers.nameDashed + '-role', skipBinary))
            .pipe(replace('@node-port', answers.nodePort, skipBinary))
            .pipe(replace('@ml-http-port', answers.appPort, skipBinary))
            .pipe(replace('@ml-xcc-port', answers.xccPort || answers.appPort, skipBinary))
            .pipe(replace('@ml-host', answers.marklogicHost, skipBinary))
            .pipe(gulp.dest('./')) // Relative to cwd
            .on('end', function() {
              done(); // Finished!
            });
        },
        function(reason) {
          console.log('Caught an error: ' + reason);
        });

  });


});
