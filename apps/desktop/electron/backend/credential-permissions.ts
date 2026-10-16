import fs from 'node:fs'
import path from 'node:path'
import { hermesHome } from '../paths.ts'

/** Metadata only: content writes remain owned by the public Hermes lifecycle. */
export function secureActiveCredentialFile(): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' ||
    typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_DIRECTORY !== 'number') {
    throw new Error('Credential storage unavailable')
  }
  const home = path.resolve(hermesHome())
  let directoryDescriptor: number | undefined
  let descriptor: number | undefined
  try {
    directoryDescriptor = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const directory = fs.fstatSync(directoryDescriptor)
    const checkDirectory = () => {
      const current = fs.lstatSync(home)
      if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o022) !== 0 ||
        current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino ||
        fs.realpathSync(home) !== home) throw new Error('Credential storage unavailable')
      // Another uid must not be able to rename a parent and substitute a different home.
      // Refuse symlinked/writable ancestors rather than weakening no-follow semantics.
      for (let ancestor = home; ; ancestor = path.dirname(ancestor)) {
        const metadata = fs.lstatSync(ancestor)
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 ||
          (metadata.uid !== 0 && metadata.uid !== process.getuid!())) {
          throw new Error('Credential storage unavailable')
        }
        if (path.dirname(ancestor) === ancestor) break
      }
    }
    checkDirectory()
    // Fixed lifecycle targets only, including legacy mirrors and credential pools.
    for (const name of ['.env', 'config.yaml', 'auth.json']) {
      const file = path.join(home, name)
      try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // lstat distinguishes absence from a dangling symlink. Never create the file ourselves.
        try { fs.lstatSync(file) } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') { checkDirectory(); continue }
          throw missing
        }
        throw new Error('Credential storage unavailable')
      }
      const checkFile = () => {
        checkDirectory()
        const opened = fs.fstatSync(descriptor!)
        const current = fs.lstatSync(file)
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid!() ||
          !current.isFile() || current.nlink !== 1 || current.uid !== opened.uid ||
          current.dev !== opened.dev || current.ino !== opened.ino) {
          throw new Error('Credential storage unavailable')
        }
        return opened
      }
      checkFile()
      fs.fchmodSync(descriptor, 0o600)
      if ((checkFile().mode & 0o7777) !== 0o600) throw new Error('Credential storage unavailable')
      fs.closeSync(descriptor)
      descriptor = undefined
    }
  } catch {
    throw new Error('Credential storage unavailable')
  } finally {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
    }
  }
}
