const {app} = require('electron')
const fs = require('fs')
const path = require('path')
const child_process = require("child_process");
const {promisify} = require('util')
const { path7za } = require("7zip-bin");
const readFile = promisify(fs.readFile)
const firstline = require('firstline')
let copyFile = promisify(fs.copyFile)
let deleteFile = promisify(fs.unlink)
const crypto = require('crypto')
const moment = require("moment");
const Store = require("electron-store");

const PouchDB = require('pouchdb');
const replicationStream = require('pouchdb-replication-stream')
PouchDB.plugin(replicationStream.plugin)


function openFile(filepath) {
  return new Promise(
    (resolve, reject) => {
      let parsedPath = path.parse(filepath);

      // Original file's full path is used as path for swap folder,
      // to prevent conflicts on opening two files with the same name.
      let swapName = filepath.split(path.sep).join("%").replace(".gko","");
      let swapFolderPath = path.join(app.getPath("userData"), swapName );

      // Create a backup of the original file, with datetime appended,
      // only if the original was modified since last backup.
      let originalStats = fs.statSync(filepath);
      let backupName = swapName + moment(originalStats.mtimeMs).format("_YYYY-MM-DD_HH-MM-SS") + parsedPath.ext;
      let backupPath = path.join(app.getPath("userData"), backupName);

      try {
        fs.copyFileSync(filepath, backupPath, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if (err.code !== "EEXIST") { throw err; }
      }

      // Unzip original *.gko file to swapFolderPath, and open a
      // document window, passing the swap folder path.
      child_process.execFile(path7za, ["x","-bd", `-o${swapFolderPath}`, filepath ], (err) => {
        if (err) { reject(err); }

        new Store({name: "swap", cwd: swapFolderPath, defaults: { originalPath : filepath }});
        resolve(swapFolderPath);
      });
    });
}




function dbToFile(database, filepath) {
  return new Promise((resolve, reject) => {
    let ws = fs.createWriteStream(filepath)
    ws.on('error', reject)

    database.dump(ws)
      .then(() => { resolve(filepath) })
      .catch(reject)
  })
}

async function dbFromFile(filepath) {
  try {
    var importResult = await importGko(filepath);
  } catch (err) {
    if(err.message == "Unexpected end of JSON input") {
      importResult = await importJSON(filepath);
    }
  }
  return importResult;
}


async function destroyDb( dbName ) {
  var dbPath = path.join(app.getPath('userData'), dbName)
  try {
    await deleteFile(path.join(app.getPath('userData'), `window-state-${dbName}.json`));
  } finally {
    return (new PouchDB(dbPath)).destroy()
  }
}


function getHashWithoutStartTime(filepath) {
  return new Promise(async (resolve, reject) => {
    try {
      const hash = crypto.createHash('sha1')
      let filecontents = await readFile(filepath, 'utf8')
      let transformedContents = filecontents.replace(/"start_time":".*","db_info"/, '"start_time":"","db_info"')
      hash.update(transformedContents)
      resolve(hash.digest('base64'))
    } catch (err) {
      reject(err)
    }
  })
}


function save(database, filepath) {
  return new Promise(async (resolve, reject) => {
    try {
      let datestring = new Date().toJSON()
      let temppath1 = filepath + datestring + ".swp1"
      let temppath2 = filepath + datestring + ".swp2"

      await dbToFile(database, temppath1)
      await dbToFile(database, temppath2)

      let hash1 = await getHashWithoutStartTime(temppath1)
      let hash2 = await getHashWithoutStartTime(temppath2)

      if (hash1 == hash2) {
        await copyFile(temppath1, filepath)
        let del1 = deleteFile(temppath1)
        let del2 = deleteFile(temppath2)
        await Promise.all([del1, del2])
        var finalHash = await getHashWithoutStartTime(filepath)

        if(hash1 == finalHash) {
          resolve({path: filepath, hash: finalHash})
        } else {
          reject(Error(`Integrity check failed on save: ${hash1} !== ${finalHash}`))
        }
      } else {
        reject(Error(`Integrity check failed on dbToFile: ${hash1} !== ${hash2}`))
      }
    } catch(err) {
      reject(err)
    }
  })
}


async function importGko(filepath) {
  var dbLine = await firstline(filepath)
  var dumpInfo= JSON.parse(dbLine)
  const hash = crypto.createHash('sha1')
  hash.update(dumpInfo.db_info.db_name + Date.now())

  var dbName = hash.digest('hex')
  var docName = path.basename(filepath, '.gko')
  var dbPath = path.join(app.getPath('userData'), dbName)
  var db = new PouchDB(dbPath)

  var rs = fs.createReadStream(filepath)
  await db.load(rs)
  await db.close()
  return { dbName : dbName, docName : docName }
}


async function importJSON(filepath) {
  let data = await readFile(filepath);

  const hash = crypto.createHash('sha1')
  hash.update(data + Date.now())
  var dbName = hash.digest('hex')
  var docName = path.basename(filepath, '.json')

  let nextId = 1

  let seed =
    JSON.parse(
        data.toString()
            .replace( /{(\s*)"content":/g
                    , s => {
                        return `{"id":"${nextId++}","content":`
                      }
                    )
      )

  let newRoot =
        { id: "0"
        , content: ""
        , children: seed
        }

  return { dbName : dbName, docName : docName , jsonImportData : newRoot };
}


module.exports =
  { openFile : openFile
  , dbToFile: dbToFile
  , dbFromFile: dbFromFile
  , destroyDb: destroyDb
  , getHash: getHashWithoutStartTime
  , save: save
  }