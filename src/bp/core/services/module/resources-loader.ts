import { Logger } from 'botpress/sdk'
import crypto from 'crypto'
import { WrapErrorsWith } from 'errors'
import fse from 'fs-extra'
import os from 'os'
import path from 'path'

import { GhostService } from '../ghost/service'

const debug = DEBUG('initialization')
  .sub('modules')
  .sub('resources')

const CHECKSUM = '//CHECKSUM:'

interface ModuleMigrationInstruction {
  /** exact name of the files to delete (path is relative to the migration file) */
  filesToDelete: string[]
}

/** Describes a resource that the module will export to the data folder */
interface ResourceExportPath {
  /** The source location of the file, in the module's folder */
  src: string
  /** Final destination of the resource on the bot's folder */
  dest: string
  /** Copy files without checking their original checksum */
  ignoreChecksum?: boolean
  ghosted?: boolean
}

export class ModuleResourceLoader {
  private exportPaths: ResourceExportPath[] = []

  private get modulePath(): string {
    return process.LOADED_MODULES[this.moduleName]
  }

  constructor(private logger: Logger, private moduleName: string, private ghost: GhostService) {}

  async runMigrations() {
    const mfile = `${this.modulePath}/migrations.json`
    if (fse.existsSync(mfile)) {
      await this._executeMigration(mfile)
    }
  }

  async importResources() {
    this.exportPaths = [
      {
        src: `${this.modulePath}/dist/actions`,
        dest: `/actions/${this.moduleName}`,
        ghosted: true
      },
      {
        src: `${this.modulePath}/assets`,
        dest: `/assets/modules/${this.moduleName}`,
        ignoreChecksum: true
      },
      {
        src: `${this.modulePath}/dist/content-types`,
        dest: `/content-types/${this.moduleName}`,
        ghosted: true
      },
      ...(await this._getHooksPaths())
    ]

    await this._loadModuleResources()
  }

  private async isSymbolicLink(filePath) {
    const fullPath = path.resolve(`${process.PROJECT_LOCATION}/${filePath}`)
    return fse.pathExistsSync(fullPath) && (await fse.lstatSync(fullPath).isSymbolicLink())
  }

  private async _loadModuleResources(): Promise<void> {
    for (const resource of this.exportPaths) {
      if (fse.pathExistsSync(resource.src) && !(await this.isSymbolicLink(resource.dest))) {
        await this._upsertModuleResources(resource)
      }
    }
  }

  async getBotTemplatePath(templateName: string) {
    return path.resolve(`${this.modulePath}/dist/bot-templates/${templateName}`)
  }

  private async _getHooksPaths(): Promise<ResourceExportPath[]> {
    const hooks: ResourceExportPath[] = []

    const moduleHooks = `${this.modulePath}/dist/hooks/`
    if (!fse.pathExistsSync(moduleHooks)) {
      return hooks
    }

    for (const hookType of await fse.readdir(moduleHooks)) {
      hooks.push({
        src: `${this.modulePath}/dist/hooks/${hookType}`,
        dest: `/hooks/${hookType}/${this.moduleName}`,
        ghosted: true
      })
    }
    return hooks
  }

  private async _upsertModuleResources(rootPath: ResourceExportPath): Promise<void> {
    if (rootPath.ignoreChecksum || !rootPath.ghosted) {
      fse.copySync(rootPath.src, process.PROJECT_LOCATION + rootPath.dest)
    } else {
      await this._updateOutdatedFiles(rootPath.src, rootPath.dest)
    }
  }

  @WrapErrorsWith('Error copying module ressources')
  private async _updateOutdatedFiles(src, dest): Promise<void> {
    const files = fse.readdirSync(src)

    for (const file of files) {
      const from = path.join(src, file)
      const to = path.join(dest, file)

      const isNewFile = !(await this.ghost.global().fileExists('/', to))
      const isModified = isNewFile || (await this._isModified(to))
      if (isNewFile || !isModified) {
        debug('adding missing file "%s"', file)
        await this.ghost.global().upsertFile('/', to, fse.readFileSync(from))
        await this._addHashToFile(to)
      } else {
        debug('not copying file "%s" because it has been changed manually', file)
      }
    }
  }

  private _calculateHash = content => {
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
  }

  /**
   * Checks if there is a checksum on the first line of the file,
   * and uses it to verify if there has been any manual changes in the file's content
   * @param filename
   */
  private _isModified = async filename => {
    const file = await this.ghost.global().readFileAsString('/', filename)
    const lines = file.split(os.EOL)
    const firstLine = lines[0]

    if (firstLine.indexOf(CHECKSUM) === 0) {
      const fileContent = lines.splice(1, lines.length).join(os.EOL)
      return this._calculateHash(fileContent) !== firstLine.substring(CHECKSUM.length)
    }

    return true
  }

  /**
   * Calculates the hash for the file's content, then adds a comment on the first line with the result
   * @param filename
   */
  private _addHashToFile = async filename => {
    const fileContent = await this.ghost.global().readFileAsString('/', filename)
    await this.ghost
      .global()
      .upsertFile('/', filename, `${CHECKSUM}${this._calculateHash(fileContent)}${os.EOL}${fileContent}`)
  }

  @WrapErrorsWith(args => `Error in migration script "${args[2]}" located at "${args[3]}".`)
  private async _executeMigration(migrationsFile: string) {
    const content: ModuleMigrationInstruction[] = JSON.parse(fse.readFileSync(migrationsFile, 'utf8'))
    if (!content) {
      throw new Error(`Expected a valid JSON object.`)
    }

    for (const migration of content) {
      if (!Array.isArray(migration.filesToDelete)) {
        continue
      }

      for (const fileToDelete of migration.filesToDelete) {
        if (await this.ghost.global().fileExists('/', fileToDelete)) {
          debug('migration deleted file "%s"', fileToDelete)
          await this.ghost.global().deleteFile('/', fileToDelete)
        } else {
          debug('not deleting file "%s", reason: not found', fileToDelete)
        }
      }
    }
  }
}
