const express = require('express');
const multer = require('multer');
const path = require('path');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const AWS = require('aws-sdk');

const app = express();
const port = 3000;
const fs = require('fs'); // Required for file system operations

// Set up multer for file upload
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Initialize SSH client
const sshClient = new Client();

// Define the SSH and SFTP connection details
const ip = '40.82.202.11';
const portSSH = 22;
const usernameSSH = 'fome';
const passwordSSH = 'fome12345678.';
const remoteInputPath = '/home/fome/data/INPUT/';
const remoteOutputPath = '/home/fome/data/OUTPUT/';

// Configure AWS SDK with provided credentials
AWS.config.update({
  accessKeyId: 'AKIA5ETPKN3SYROGMZOZ',
  secretAccessKey: 'm1DhV5KSKhzhFrYna1TR5GXyqa2EnaORvgHxWXP+',
  region: 'ap-southeast-2' // Specify the region of your bucket
});

const s3 = new AWS.S3();
const bucketName = 'vidaccess';
const inputFolder = 'INPUT/';
const outputFolder = 'OUTPUT/';

// Function to upload file to S3 and return the S3 URI
function uploadToS3(buffer, s3Bucket, s3Key) {
  return new Promise((resolve, reject) => {
    const params = {
      Bucket: s3Bucket,
      Key: s3Key,
      Body: buffer,
    };

    s3.upload(params, (err, data) => {
      if (err) {
        console.error('S3 upload error:', err);
        reject(err);
      } else {
        const s3Uri = `s3://${s3Bucket}/${s3Key}`;
        console.log(`File uploaded successfully to S3 at ${s3Uri}`);
        resolve(s3Uri);
      }
    });
  });
}

// Function to connect SSH client
function connectSSHClient() {
  return new Promise((resolve, reject) => {
    sshClient.on('ready', () => {
      console.log('SSH client connected');
      resolve();
    }).on('error', (err) => {
      console.error('SSH connection error:', err);
      reject(err);
    }).connect({ host: ip, port: portSSH, username: usernameSSH, password: passwordSSH });
  });
}

// Function to execute SSH commands
function executeSSHCommands(commands) {
  return new Promise((resolve, reject) => {
    sshClient.exec(commands, (err, stream) => {
      if (err) {
        console.error('SSH command execution error:', err);
        reject(err);
      }
      stream.on('close', (code, signal) => {
        console.log(`SSH command execution closed with code ${code} and signal ${signal}`);
        sshClient.end();
        resolve();
      }).on('data', (data) => {
        console.log('STDOUT:', data.toString());
      }).stderr.on('data', (data) => {
        console.error('STDERR:', data.toString());
      });
    });
  });
}

// Function to read JSON file content from remote server
async function readJsonFile(remoteFilePath) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: ip, port: portSSH, username: usernameSSH, password: passwordSSH });
    const data = await sftp.get(remoteFilePath);
    const outputData = JSON.parse(data.toString('utf8'));
    return outputData;
  } catch (error) {
    console.error('SFTP read JSON file error:', error);
    throw error;
  } finally {
    await sftp.end();
  }
}

// Define the upload route
app.post('/upload', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file; // Access the uploaded file information
  const { action } = req.body; // Get the 'action' variable from the request body

  if (!uploadedFile) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!action) {
    return res.status(400).json({ error: 'Action parameter missing' });
  }

  // Upload the file to S3
  const fileKey = `${inputFolder}${uploadedFile.originalname}`;
  let s3Uri;
  try {
    s3Uri = await uploadToS3(uploadedFile.buffer, bucketName, fileKey);
  } catch (error) {
    console.error('S3 upload error:', error);
    return res.status(500).json({ error: 'Server error' });
  }

  // Connect SSH client
  try {
    await connectSSHClient();
  } catch (error) {
    console.error('SSH connection error:', error);
    return res.status(500).json({ error: 'Server error' });
  }

  // Execute SSH commands with the user-provided action
  const commands = `
    cd /home/fome/anaconda3/bin;
    source activate;
    cd /home/fome/Cloud_Pose;
    python pose_main.py --video_path ${remoteInputPath + uploadedFile.originalname} --action ${action}
  `;
  try {
    await executeSSHCommands(commands);
  } catch (error) {
    console.error('SSH command execution error:', error);
    return res.status(500).json({ error: 'Server error' });
  }

  // Read the JSON file content from the remote server
  const originalFileNameWithoutExt = path.parse(uploadedFile.originalname).name;
  const outputFileNameJson = `${originalFileNameWithoutExt}.json`;
  const remoteOutputFilePathJson = remoteOutputPath + outputFileNameJson;
  let outputData;
  try {
    outputData = await readJsonFile(remoteOutputFilePathJson);
  } catch (error) {
    console.error('SFTP read JSON file error:', error);
    return res.status(500).json({ error: 'Server error' });
  }

  // Upload the processed video to S3
  const outputFileName = `${originalFileNameWithoutExt}_${action}_pose.mp4`;
  const remoteOutputFilePath = remoteOutputPath + outputFileName;
  const processedS3Key = `${outputFolder}${outputFileName}`;
  try {
    const sftp = new SftpClient();
    await sftp.connect({ host: ip, port: portSSH, username: usernameSSH, password: passwordSSH });
    const processedVideoBuffer = await sftp.get(remoteOutputFilePath);
    await sftp.end();
    const processedS3Uri = await uploadToS3(processedVideoBuffer, bucketName, processedS3Key);
    res.status(200).json({
      message: 'Video processed and uploaded to S3 successfully',
      uploadedS3Uri: s3Uri,
      processedS3Uri: processedS3Uri,
      outputData
    });
  } catch (error) {
    console.error('SFTP download or S3 upload error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
