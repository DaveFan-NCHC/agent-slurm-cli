import { timingSafeEqual } from "node:crypto";
import { close, lstat, open, read, readFileSync, realpath, rename, stat, unlink, write } from "node:fs";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const hostKey = readFileSync(process.env.SLURM_TEST_HOST_KEY);
const authorizedKey = utils.parseKey(readFileSync(process.env.SLURM_TEST_AUTHORIZED_KEY));
if (authorizedKey instanceof Error) throw authorizedKey;

function equal(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function statusFor(error) {
  if (error?.code === "ENOENT") return STATUS_CODE.NO_SUCH_FILE;
  if (error?.code === "EACCES" || error?.code === "EPERM") return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function attributes(stats) {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function openFlags(flags) {
  const readRequested = (flags & OPEN_MODE.READ) !== 0;
  const writeRequested = (flags & OPEN_MODE.WRITE) !== 0;
  if (readRequested && writeRequested) return "r+";
  if (readRequested) return "r";
  if ((flags & OPEN_MODE.APPEND) !== 0) return (flags & OPEN_MODE.EXCL) !== 0 ? "ax" : "a";
  if (writeRequested) {
    if ((flags & OPEN_MODE.EXCL) !== 0) return "wx";
    if ((flags & OPEN_MODE.TRUNC) !== 0) return "w";
    return "r+";
  }
  return undefined;
}

function attachSftp(session) {
  session.on("sftp", (accept) => {
    const sftp = accept();
    const handles = new Map();
    let nextHandle = 0;
    const lookup = (handle) => handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined;

    sftp.on("OPEN", (requestId, filename, flags, attrs) => {
      const nodeFlags = openFlags(flags);
      if (!nodeFlags) return sftp.status(requestId, STATUS_CODE.OP_UNSUPPORTED);
      open(filename, nodeFlags, attrs.mode ?? 0o600, (error, descriptor) => {
        if (error) return sftp.status(requestId, statusFor(error));
        const id = nextHandle++;
        handles.set(id, descriptor);
        const handle = Buffer.alloc(4);
        handle.writeUInt32BE(id);
        sftp.handle(requestId, handle);
      });
    });
    sftp.on("READ", (requestId, handle, offset, length) => {
      const descriptor = lookup(handle);
      if (descriptor === undefined) return sftp.status(requestId, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      read(descriptor, buffer, 0, length, Number(offset), (error, bytesRead) => {
        if (error) return sftp.status(requestId, statusFor(error));
        if (bytesRead === 0) return sftp.status(requestId, STATUS_CODE.EOF);
        sftp.data(requestId, buffer.subarray(0, bytesRead));
      });
    });
    sftp.on("WRITE", (requestId, handle, offset, data) => {
      const descriptor = lookup(handle);
      if (descriptor === undefined) return sftp.status(requestId, STATUS_CODE.FAILURE);
      write(descriptor, data, 0, data.length, Number(offset), (error) => {
        sftp.status(requestId, error ? statusFor(error) : STATUS_CODE.OK);
      });
    });
    sftp.on("CLOSE", (requestId, handle) => {
      const id = handle.length === 4 ? handle.readUInt32BE(0) : undefined;
      const descriptor = id === undefined ? undefined : handles.get(id);
      if (descriptor === undefined || id === undefined) return sftp.status(requestId, STATUS_CODE.FAILURE);
      handles.delete(id);
      close(descriptor, (error) => sftp.status(requestId, error ? statusFor(error) : STATUS_CODE.OK));
    });
    const sendAttributes = (operation, requestId, path) => {
      operation(path, (error, stats) => {
        if (error) return sftp.status(requestId, statusFor(error));
        sftp.attrs(requestId, attributes(stats));
      });
    };
    sftp.on("STAT", (requestId, path) => sendAttributes(stat, requestId, path));
    sftp.on("LSTAT", (requestId, path) => sendAttributes(lstat, requestId, path));
    sftp.on("REALPATH", (requestId, path) => {
      realpath(path, (error, resolved) => {
        if (error) return sftp.status(requestId, statusFor(error));
        sftp.name(requestId, [{ filename: resolved, longname: resolved, attrs: {} }]);
      });
    });
    sftp.on("RENAME", (requestId, oldPath, newPath) => {
      rename(oldPath, newPath, (error) => sftp.status(requestId, error ? statusFor(error) : STATUS_CODE.OK));
    });
    sftp.on("REMOVE", (requestId, path) => {
      unlink(path, (error) => sftp.status(requestId, error ? statusFor(error) : STATUS_CODE.OK));
    });
  });
}

const clients = new Set();
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client);
  client.on("authentication", (context) => {
    if (context.username !== process.env.SLURM_TEST_USER || context.method !== "publickey") {
      context.reject();
      return;
    }
    const validKey = context.key.algo === authorizedKey.type
      && equal(context.key.data, authorizedKey.getPublicSSH());
    const validSignature = !context.signature
      || authorizedKey.verify(context.blob, context.signature, context.hashAlgo) === true;
    if (validKey && validSignature) context.accept(); else context.reject();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      attachSftp(session);
      session.on("exec", (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const command = spawn("/bin/sh", ["-c", info.command], {
          env: { ...process.env, PATH: process.env.SLURM_TEST_PATH },
          stdio: ["ignore", "pipe", "pipe"],
        });
        command.stdout.pipe(channel, { end: false });
        command.stderr.pipe(channel.stderr, { end: false });
        command.on("close", (code) => {
          channel.exit(code ?? 1);
          channel.end();
        });
        command.on("error", (error) => {
          channel.stderr.write(`${error.message}\n`);
          channel.exit(127);
          channel.end();
        });
      });
    });
  });
  client.on("close", () => clients.delete(client));
  client.on("error", (error) => process.stderr.write(`${error.stack ?? error.message}\n`));
});

server.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
server.listen(Number(process.env.SLURM_TEST_PORT), "127.0.0.1", () => process.stdout.write("READY\n"));

function shutdown() {
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
