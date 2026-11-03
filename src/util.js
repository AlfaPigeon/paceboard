import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function id(prefix = '') {
  const u = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${u}` : u;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, n));
  }
  fs.closeSync(fd);
  return hash.digest('hex');
}

export function runCmd(cmd, args, { onStdout, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      onStdout?.(d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      onStderr?.(d.toString());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(Object.assign(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`), { code, stdout, stderr }));
    });
  });
}

export function parseFfprobe(jsonText) {
  const data = JSON.parse(jsonText);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration || video?.duration || 0);
  return {
    duration,
    format: data.format?.format_name,
    size: Number(data.format?.size || 0),
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: (() => {
            const [a, b] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
            return b ? a / b : 0;
          })(),
        }
      : null,
    audio: audio ? { codec: audio.codec_name, channels: audio.channels } : null,
    raw: data,
  };
}
