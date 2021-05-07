const core = require('@actions/core');
const exec = require('@actions/exec');
const path = require('path');

function wait(seconds) {
  return new Promise(resolve => {
    if ((typeof seconds) !== 'number') {
      throw new Error('seconds not a number');
    }

    core.info(`Waiting ${seconds} seconds...`);

    setTimeout(() => resolve("done!"), seconds * 1000)
  });
}

async function isNextReleaseHealthy(release, app) {
  let releasesOutput = '';

  const options = {
    listeners: {
      stdout: data => {
        releasesOutput += data.toString();
      }
    }
  };

  await core.group("Getting current replicas", async () => {
    await exec.exec(`gigalixir ps -a ${app}`, [], options);
  });

  const releases = JSON.parse(releasesOutput);
  return releases.pods.filter((pod) => (Number(pod.version) === release && pod.status === "Healthy")).length >= releases.replicas_desired;
}

async function waitForNewRelease(oldRelease, app, attempts) {
  const maxAttempts = 60;

  await core.group("Scaling new app", async () => {
    await exec.exec(`gigalixir ps:scale --replicas=1 -a ${app}`);
  });

  if (await isNextReleaseHealthy(oldRelease + 1, app)) {
    return await Promise.resolve(true);
  } else {
    if (attempts <= maxAttempts) {
      await wait(10);
      await waitForNewRelease(oldRelease, app, attempts + 1);
    } else {
      throw "Taking too long for new release to deploy";
    }
  }
}

async function appExists(app) {
  let appOutput = '';

  const options = {
    listeners: {
      stdout: data => {
        appOutput += data.toString();
      }
    }
  };

  await core.group("Retrieving current apps", async () => {
    await exec.exec(`gigalixir apps`, [], options);
  });

  const apps = JSON.parse(appOutput);
  for (let i = 0; i < apps.length; i++) {
    if (apps[i].unique_name == app) {
      return true
    }
  }
  return false;
}

async function createApp(app, createDatabase, configValues) {
  let appCreationOutput = '';

  const options = {
    listeners: {
      stdout: data => {
        appCreationOutput += data.toString();
      }
    }
  };

  await core.group("Creating new app", async () => {
    await exec.exec(`gigalixir apps:create -n ${app}`, [], options);
  });
  
  if (createDatabase) {
    await core.group("Creating Database for app", async () => {
      await exec.exec(`gigalixir pg:create -a ${app} --free --yes`, [], options);
    });
  }

  var configs = configValues.split(/\r?\n/);
  configs.forEach(async function(config) {
    var index = config.indexOf('=')
    if (index != -1) {
      var key = config.slice(0, index);
      var value = config.slice(index+1);
      await core.group(`Setting ${key} for app`, async () => {
        await exec.exec(`gigalixir config:set -a ${app} ${key}=${value}`, [], options);
      });
    }
  })
}

async function getCurrentRelease(app) {
  let releasesOutput = '';

  const options = {
    listeners: {
      stdout: data => {
        releasesOutput += data.toString();
      }
    }
  };

  await core.group("Getting current release", async () => {
    await exec.exec(`gigalixir releases -a ${app}`, [], options);
  });

  const releases = JSON.parse(releasesOutput);
  const currentRelease = releases.length ? Number(releases[0].version) : 0;

  return currentRelease;
}

function formatReleaseMessage(releaseNumber) {
  return releaseNumber ?
    `The current release is ${releaseNumber}` :
    "This is the first release";
}

async function run() {
  try {
    const baseInputOptions = {
      required: true
    };
    const otherInputOptions = {
      required: false
    }
    const gigalixirUsername = core.getInput('GIGALIXIR_USERNAME', baseInputOptions);
    const gigalixirPassword = core.getInput('GIGALIXIR_PASSWORD', baseInputOptions);
    const sshPrivateKey = core.getInput('SSH_PRIVATE_KEY', baseInputOptions);
    const gigalixirApp = core.getInput('GIGALIXIR_APP', baseInputOptions);
    const migrations = core.getInput('MIGRATIONS', baseInputOptions);
    const createDatabase = core.getInput('CREATE_DATABASE', baseInputOptions);
    const setUrlHost = core.getInput('SET_URL_HOST', otherInputOptions);
    const configValues = core.getInput('CONFIG_VALUES', otherInputOptions);

    await core.group("Installing gigalixir", async () => {
      await exec.exec('pip3 install gigalixir')
    });

    await core.group("Logging in to gigalixir", async () => {
      await exec.exec(`gigalixir login -e "${gigalixirUsername}" -y -p "${gigalixirPassword}"`)
    });

    await core.group("Setting git remote for gigalixir", async () => {
      await exec.exec(`gigalixir git:remote ${gigalixirApp}`);
    });

    const existingApp = await core.group("Checking existing apps", async () => {
      return await appExists(gigalixirApp);
    });

    if (!existingApp) {
      await core.group("Creating new apps", async () => {
        return await createApp(gigalixirApp, createDatabase, setUrlHost, configValues);
      });
    }

    const currentRelease = await core.group("Getting current release", async () => {
      return await getCurrentRelease(gigalixirApp);
    });

    core.info(formatReleaseMessage(currentRelease));

    if (setUrlHost) {
      await core.group("Setting URL_HOST for app", async () => {
        await exec.exec(`gigalixir config:set -a ${gigalixirApp} URL_HOST=${gigalixirApp}.gigalixirapp.com`);
      });
    }

    await core.group("Deploying to gigalixir", async () => {
      await exec.exec("git push -f gigalixir HEAD:refs/heads/master");
    });

    if (migrations === "true") {
      await core.group("Adding private key to gigalixir", async () => {
        await exec.exec(path.join(__dirname, "../bin/add-private-key"), [sshPrivateKey]);
      });

      await core.group("Waiting for new release to deploy", async () => {
        await waitForNewRelease(currentRelease, gigalixirApp, 1);
      });

      try {
        await core.group("Running migrations", async () => {
          await exec.exec(`gigalixir ps:migrate -a ${gigalixirApp}`)
        });
      } catch (error) {
        if (currentRelease === 0) {
          core.warning("Migration failed");
        } else {
          core.warning(`Migration failed, rolling back to the previous release: ${currentRelease}`);
          await core.group("Rolling back", async () => {
            await exec.exec(`gigalixir releases:rollback -a ${gigalixirApp}`)
          });
        }

        core.setFailed(error.message);
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
