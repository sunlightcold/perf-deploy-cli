const childProcess = require('child_process');
const fs = require('fs');
const { NodeSSH } = require('node-ssh');
const shelljs = require('shelljs');
const { successLog, errorLog, underlineLog } = require('../utils/index');
const path = require('path');
const projectDir = process.cwd();
const archiver = require('archiver');
const ssh = new NodeSSH(); // 生成ssh实例
let MAX_TRY; // 文件传输失败最大重生次数
let stepNum = 1; // 执行步骤记录

// 部署流程入口
async function deploy(config) {
  const { script, isNpmBuild, webDir, distPath, maxTry, projectName, svnLocalPath, svnCommitMsg } = config;

  MAX_TRY = maxTry;
  
  // 判断是否需要重新打包
  if (isNpmBuild) {
    execBuild(script);
  }
  await connectSSH(config);

  // 多路径部署
  for (const remotePath of webDir) {
    await clearOldFile(remotePath);
    const zipName = getZipName(projectName);
    const fullDistFilePath = await zipFiles(distPath, zipName);
    const fullRemoteFilePath = `${remotePath}/${zipName}`;
    await uploadDirectory(fullDistFilePath, fullRemoteFilePath);
    await unZip(remotePath, zipName);
    successLog(`项目部署成功`);
    await pushSvn(distPath, svnLocalPath, svnCommitMsg);
  }
  process.exit(0);
}

// 执行打包脚本
function execBuild(script) {
  try {
    console.log(`(${stepNum++}) 执行打包脚本 ${underlineLog(script)}`);
    successLog(`打包中...`)
    childProcess.execSync(`${script}`);
    successLog(`打包成功`);
  } catch (err) {
    errorLog(err);
    process.exit(1);
  }
}

// 连接SSH
async function connectSSH(config) {
  const { host, port, username, password, privateKey, passphrase } = config;
  const sshConfig = {
    host,
    port,
    username,
    password,
    privateKey: privateKey || null,
    passphrase: passphrase || null,
  };
  try {
    console.log(`(${stepNum++}) 连接 ${underlineLog(host)}`);
    await ssh.connect(sshConfig);
    successLog('SSH连接成功');
  } catch (err) {
    errorLog(`连接失败 ${err}`);
    process.exit(1);
  }
}

// 清空远端目录
async function clearOldFile(remotePath) {
  try {
    console.log(`(${stepNum++}) 清空远端目录 ${underlineLog(remotePath)}`);
    await runCommand(`cd ${remotePath}`, remotePath);
    await runCommand(`rm -rf *`, remotePath);
    successLog('远端目录清空成功');
  } catch (err) {
    errorLog(`远端目录清空失败 ${err}`);
    process.exit(1);
  }
}

// 压缩上传文件
async function zipFiles(distPath, zipName) {
  const fullDistPath = path.resolve(projectDir, distPath);
  const fullDistFilePath = path.resolve(projectDir, distPath, zipName);

  console.log(`(${stepNum++}) 压缩打包本地目录 ${underlineLog(fullDistPath)}`);

  try {
    fs.accessSync(fullDistFilePath, fs.constants.F_OK);
    successLog(`检测打包路径压缩文件 ${zipName} 已存在，直接上传`);
    // successLog(`删除 ${zipName} 文件，重新创建`);
    // fs.unlinkSync(fullDistFilePath);
  } catch (error) {
    successLog(`创建文件 ${zipName}`);

    const output = fs.createWriteStream(fullDistFilePath);
    // throw new Error();
  
    const archive = archiver('zip', {
      store: true,
      zlib: { level: 9 }
    });
    archive.pipe(output);
    archive.glob(`!(${zipName})`, { cwd: fullDistPath });
  
    try {
      successLog(`${zipName} 文件存档中...`)
      await archive.finalize();
    } catch (error) {
      errorLog(`${zipName} 存档失败, ${error}`);
      process.exit(1);
    }
  
    successLog(`${zipName} 存档成功 ${archive.pointer()} 字节`);
  }


  return fullDistFilePath;
}

// 上传文件夹
async function uploadDirectory(fullDistFilePath, fullRemoteFilePath) {
  for (let index = 1; index <= MAX_TRY; index++) {
    try {
      if (index === 1) {
        console.log(`(${stepNum++}) 上传文件到 ${underlineLog(fullRemoteFilePath)}`);
      } else {
        console.log(`(${stepNum++}) 上传文件到 ${underlineLog(fullRemoteFilePath)}, 次数 ${index} 重试中...`);
      }
      successLog(`文件上传中...`);
      await ssh.putFile(fullDistFilePath, fullRemoteFilePath);
      successLog(`文件上传成功`);
      successLog(`删除压缩文件 ${underlineLog(fullDistFilePath)}`);
      shelljs.rm('-rf', fullDistFilePath);
      break;
    } catch (err) {
      if (index === MAX_TRY) {
        errorLog(`文件传输异常 ${err}, 重试次数 ${MAX_TRY} 退出程序`);
        process.exit(1);
      } else {
        errorLog(`文件传输异常 ${err}`);
      }
    }
  }
}

// 解压文件
async function unZip(remotePath, zipName) {
  const filePath = `${remotePath}/${zipName}`
  console.log(`(${stepNum++}) 解压远端文件 ${underlineLog(filePath)}`);
  successLog(`解压中...`);
  try {
    await runCommand(`cd ${remotePath}`, remotePath);
    await runCommand(`unzip ${zipName}`, remotePath);
  } catch (error) {
    console.log(`${zipName} 解压失败`, error);
    process.exit(1);
  }
  successLog(`解压成功`);
}

// 更新提交 svn
async function pushSvn(distPath, svnLocalPath, svnCommitMsg) {
  console.log(`(${stepNum++}) 更新 svn`);

  await runShellCommand(`svn update`, svnLocalPath);
  
  const safeSvnPath = getSafeSvnPath(svnLocalPath);
  successLog(`删除目录所有 svn 版本控制文件 ${underlineLog(safeSvnPath)}`);
  shelljs.rm('-rf', `${safeSvnPath}*`);
  // await runShellCommand(`svn delete ./*`, svnLocalPath);

  const fullDistPath = path.join(projectDir, distPath, '/');
  const source = `${fullDistPath}*`;
  const dest = `${path.join(safeSvnPath, '/')}*`;
  successLog(`拷贝文件 ${underlineLog(source)} -> ${underlineLog(dest)}`);
  await runShellCommand(`xcopy ${source} ${dest} /y /s`, svnLocalPath);

  successLog(`svn 添加未版本控制的文件 ${underlineLog(svnLocalPath)}`);
  await runShellCommand(`svn add . --force`, svnLocalPath);

  successLog(`svn 删除已物理删除的文件 ${underlineLog(svnLocalPath)}`);
  // await runShellCommand(`svn status | grep "^\!" | awk '{print $2}' | xargs svn del --quiet`, svnLocalPath);
  // await runShellCommand(`for i in  $(svn st | grep \! | awk '{print $2}'); do svn delete $i; done`, svnLocalPath);

  successLog(`提交 svn ${underlineLog(safeSvnPath)}`);
  // await runShellCommand(`svn commit -m"${svnCommitMsg}"`, svnLocalPath);
}

// 执行 ssh 命令
async function runCommand(command, dir) {
  await ssh.execCommand(command, { cwd: dir });
}

// 执行 shell 命令
async function runShellCommand(command, dir) {
  return new Promise((resolve, reject) => {
    try {
      if (dir) {
        shelljs.cd(dir);
      }
    } catch (error) {
      reject(error);
    }
    shelljs.exec(command, (code, stdout, stderr) => {
      resolve(code);
    });
  });
}

function getZipName(projectName) {
  const zipName = `${projectName}.zip` || `project.zip`;
  return zipName;
}

function getSafeSvnPath(svnLocalPath) {
  if (svnLocalPath.endsWith('/')) {
    return svnLocalPath;
  } else {
    return `${svnLocalPath}/`
  }
}

module.exports = deploy;
