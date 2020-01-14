const path = require('path');
const childProcess = require('child_process');
const node_ssh = require('node-ssh');
const { successLog, errorLog, underlineLog } = require('../utils/index');
const projectDir = process.cwd();
const MAX_TRY = 5; // 文件传输失败最大重生次数

let ssh = new node_ssh(); // 生成ssh实例

// 部署流程入口
async function deploy(config) {
  const { script, webDir, distPath, projectName, name } = config;
  // execBuild(script);
  await connectSSH(config);
  for (const dir of webDir) {
    await clearOldFile(dir);
    await uploadDirectory(distPath, dir);
    successLog(`\n 项目部署成功\n`);
  }
  process.exit(0);
}

// 第一步，执行打包脚本
function execBuild(script) {
  try {
    console.log(`\n（1）${script}, 打包中...`);
    childProcess.execSync(`${script}`);
    successLog('  打包成功');
  } catch (err) {
    errorLog(err);
    process.exit(1);
  }
}

// 第二步，连接SSH
async function connectSSH(config) {
  const { host, port, username, password, privateKey, passphrase } = config;
  const sshConfig = {
    host,
    port,
    username,
    password,
    privateKey,
    passphrase,
  };
  try {
    console.log(`（2）连接${underlineLog(host)}`);
    await ssh.connect(sshConfig);
    successLog('  SSH连接成功');
  } catch (err) {
    errorLog(`  连接失败 ${err}`);
    process.exit(1);
  }
}

// 运行命令
async function runCommand(command, dir) {
  await ssh.execCommand(command, { cwd: dir });
}

// 第三步，清空远端目录
async function clearOldFile(dir) {
  try {
    console.log('（3）清空远端目录');
    await runCommand(`cd ${dir}`, dir);
    await runCommand(`rm -rf *`, dir);
    successLog('  远端目录清空成功');
  } catch (err) {
    errorLog(`  远端目录清空失败 ${err}`);
    process.exit(1);
  }
}

// 第四步，上传文件夹
async function uploadDirectory(distPath, dir) {
  for (let index = 1; index <= MAX_TRY; index++) {
    try {
      if (index === 1) {
        console.log(` (4)上传文件到${underlineLog(dir)}`);
      } else {
        console.log(` (4)上传文件到${underlineLog(dir)}, 次数 ${index} 重试中...`);
      }
      await ssh.putDirectory(path.resolve(projectDir, distPath), dir, {
        recursive: true,
        concurrency: 10,
      });
      successLog('  文件上传成功');
      break;
    } catch (err) {
      if (index === MAX_TRY) {
        errorLog(`  文件传输异常 ${err}, 重试次数 ${MAX_TRY} 退出程序`);
        process.exit(1);
      } else {
        errorLog(`  文件传输异常 ${err}`);
      }
    }
  }
}

module.exports = deploy;
