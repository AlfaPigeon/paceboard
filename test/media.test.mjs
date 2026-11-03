import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-media-'));
process.env.STORYBOARD_DATA = tmp;
process.env.STORYBOARD_DB = path.join(tmp, 'media.sqlite');
process.env.STORYBOARD_NO_LISTEN = '1';

const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (ff.status !== 0) {
  test('ffmpeg available', { skip: 'ffmpeg missing' }, () => {});
} else {
  const { enqueueMediaProcess, getMedia } = await import('../src/services/media.js');
  const { getJob } = await import('../src/services/jobs.js');
  const { getDb } = await import('../src/db.js');
  getDb();

  test('ffmpeg pipeline: probe, proxy, thumbs, waveform, scenes on test MKV', async () => {
    const src = path.join(tmp, 'sample.mkv');
    // 3s color bars + sine; hard scene change mid-way via concat filter would be heavy —
    // use two segments joined: 1.5s red then 1.5s blue.
    const mk = spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=1.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1.5',
      '-f', 'lavfi', '-i', 'sine=f=440:d=3',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      src,
    ], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr?.slice(-500));

    const { media, job, cached } = enqueueMediaProcess({ sourcePath: src });
    assert.equal(cached, false);
    assert.ok(job?.id);

    const started = Date.now();
    let final = getJob(job.id);
    while (!['done', 'error', 'cancelled'].includes(final.status) && Date.now() - started < 120000) {
      await new Promise((r) => setTimeout(r, 400));
      final = getJob(job.id);
    }
    assert.equal(final.status, 'done', final.error || JSON.stringify(final));

    const ready = getMedia(media.id);
    assert.equal(ready.status, 'ready');
    assert.ok(ready.proxyPath && fs.existsSync(ready.proxyPath));
    assert.ok(ready.durationSec > 2.5);
    assert.ok(ready.thumbs.length >= 1);
    assert.ok(ready.waveform.length > 10);
    assert.ok(ready.scenes.length >= 1);

    // cache hit
    const again = enqueueMediaProcess({ sourcePath: src });
    assert.equal(again.cached, true);
  });
}
