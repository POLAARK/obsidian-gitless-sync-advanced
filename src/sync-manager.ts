import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  NewTreeRequestItem,
  RepoContent,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import {
  decodeBase64String,
  hasTextExtension,
  isIgnoredPath,
  parseIgnorePatterns,
} from "./utils";
import GitHubSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

export type SyncActionType =
  | "upload"
  | "download"
  | "delete_local"
  | "delete_remote";

export interface SyncAction {
  type: SyncActionType;
  filePath: string;
}

export type SyncDirection = "both" | "pull" | "push";

export interface OperationOptions {
  commitMessage?: string;
  createBackup?: boolean;
}

export interface SyncStatus {
  uploads: SyncAction[];
  downloads: SyncAction[];
  conflicts: ConflictFile[];
  hasRemoteManifest: boolean;
  remoteFileCount: number;
  localFileCount: number;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

/**
 * Raised by the first sync when both the remote repository and the local
 * vault contain files and there is no shared manifest yet. The user must
 * explicitly choose how to reconcile the two sides.
 */
export class BootstrapRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapRequiredError";
  }
}

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
    );
  }

  private get manifestPath(): string {
    return `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
  }

  private isIgnored(filePath: string): boolean {
    return isIgnoredPath(
      filePath,
      parseIgnorePatterns(this.settings.ignorePatterns),
    );
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 ||
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  /**
   * Collects every syncable file in the vault, walking the folders.
   * The manifest file is never included, callers handle it explicitly.
   */
  private async collectLocalFiles(): Promise<string[]> {
    let files: string[] = [];
    const folders: string[] = [this.vault.getRoot().path];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    return files.filter(
      (filePath) => filePath !== this.manifestPath && !this.isIgnored(filePath),
    );
  }

  /**
   * Runs an operation showing a notice and guarding against concurrent syncs.
   * Errors are reported through a notice and logged, they are not rethrown.
   *
   * @returns True when the operation succeeded
   */
  private async runWithNotice(
    label: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    if (this.syncing) {
      await this.logger.info(`${label} already in progress`);
      return false;
    }
    const notice = new Notice(`${label}...`);
    this.syncing = true;
    try {
      await fn();
      new Notice(`${label} successful`, 5000);
      return true;
    } catch (err) {
      await this.logger.error(`${label} failed`, err);
      new Notice(`Error: ${err}`, 10000);
      return false;
    } finally {
      this.syncing = false;
      notice.hide();
    }
  }

  /**
   * Handles first sync with remote and local.
   * Throws a BootstrapRequiredError when both sides have files, in that
   * case the user has to pick how to reconcile them.
   */
  async firstSync() {
    if (this.syncing) {
      this.logger.info("First sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    this.syncing = true;
    try {
      await this.firstSyncImpl();
    } finally {
      this.syncing = false;
    }
  }

  private async firstSyncImpl() {
    await this.logger.info("Starting first sync");
    let repositoryIsEmpty = false;
    let res: RepoContent;
    let files: {
      [key: string]: GetTreeResponseItem;
    } = {};
    let treeSha: string = "";
    try {
      res = await this.client.getRepoContent();
      files = res.files;
      treeSha = res.sha;
    } catch (err) {
      // 409 is returned in case the remote repo has been just created
      // and contains no files.
      // 404 instead is returned in case there are no files.
      // Either way we can handle both by commiting a new empty manifest.
      if (err.status !== 409 && err.status !== 404) {
        throw err;
      }
      // The repository is bare, meaning it has no tree, no commits and no branches
      repositoryIsEmpty = true;
    }

    if (repositoryIsEmpty) {
      await this.logger.info("Remote repository is empty");
      // Since the repository is completely empty we need to create a first commit.
      // We can't create that by going throught the normal sync process since the
      // API doesn't let us create a new tree when the repo is empty.
      // So we create a the manifest file as the first commit, since we're going
      // to create that in any case right after this.
      const buffer = await this.vault.adapter.readBinary(
        normalizePath(this.manifestPath),
      );
      await this.client.createFile({
        path: this.manifestPath,
        content: arrayBufferToBase64(buffer),
        message: this.commitMessage(),
        retry: true,
      });
      // Now get the repo content again cause we know for sure it will return a
      // valid sha that we can use to create the first sync commit.
      res = await this.client.getRepoContent({ retry: true });
      files = res.files;
      treeSha = res.sha;
    }

    const vaultIsEmpty = await this.vaultIsEmpty();

    if (!repositoryIsEmpty && !vaultIsEmpty) {
      // Both have files and there is no shared manifest to merge against.
      // The user must explicitly choose how to reconcile the two sides.
      await this.logger.error("Both remote and local have files, can't sync");
      throw new BootstrapRequiredError(
        "Both remote and local contain files. Choose whether to use the remote, " +
          "use the local files, or merge them.",
      );
    } else if (repositoryIsEmpty) {
      // Remote has no files and no manifest, let's just upload whatever we have locally.
      await this.firstSyncFromLocal(files, treeSha);
    } else {
      // Local has no files and there's no manifest in the remote repo.
      // Let's download whatever we have in the remote repo.
      await this.firstSyncFromRemote(files, treeSha);
    }
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from remote files");

    // We want to avoid getting throttled by GitHub, so instead of making a request for each
    // file we download the whole repository as a ZIP file and extract it in the vault.
    // We exclude config dir files if the user doesn't want to sync those.
    const zipBuffer = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipBuffer]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    await this.logger.info("Extracting files from ZIP", {
      length: entries.length,
    });

    await Promise.all(
      entries.map(async (entry: Entry) => {
        // All repo ZIPs contain a root directory that contains all the content
        // of that repo, we need to ignore that directory so we strip the first
        // folder segment from the path
        const pathParts = entry.filename.split("/");
        const targetPath =
          pathParts.length > 1 ? pathParts.slice(1).join("/") : entry.filename;

        if (targetPath === "") {
          // Must be the root folder, skip it.
          // This is really important as that would lead us to try and
          // create the folder "/" and crash Obsidian
          return;
        }

        if (
          this.settings.syncConfigDir &&
          targetPath.startsWith(this.vault.configDir) &&
          targetPath !== this.manifestPath
        ) {
          await this.logger.info("Skipped config", { targetPath });
          return;
        }

        if (this.isIgnored(targetPath) && targetPath !== this.manifestPath) {
          await this.logger.info("Skipped ignored file", targetPath);
          return;
        }

        if (entry.directory) {
          const normalizedPath = normalizePath(targetPath);
          await this.vault.adapter.mkdir(normalizedPath);
          await this.logger.info("Created directory", {
            normalizedPath,
          });
          return;
        }

        if (targetPath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
          // We don't want to download the log file if the user synced it in the past.
          return;
        }

        if (targetPath.split("/").last()?.startsWith(".")) {
          // We must skip hidden files as that creates issues with syncing.
          // This is fine as users can't edit hidden files in Obsidian anyway.
          await this.logger.info("Skipping hidden file", targetPath);
          return;
        }

        const writer = new Uint8ArrayWriter();
        await entry.getData!(writer);
        const data = await writer.getData();
        const dir = targetPath.split("/").splice(0, -1).join("/");
        if (dir !== "") {
          const normalizedDir = normalizePath(dir);
          await this.vault.adapter.mkdir(normalizedDir);
          await this.logger.info("Created directory", {
            normalizedDir,
          });
        }

        const normalizedPath = normalizePath(targetPath);
        await this.vault.adapter.writeBinary(normalizedPath, data);
        await this.logger.info("Written file", {
          normalizedPath,
        });
        this.metadataStore.data.files[normalizedPath] = {
          path: normalizedPath,
          sha: files[normalizedPath]?.sha ?? null,
          dirty: false,
          justDownloaded: true,
          lastModified: Date.now(),
        };
        await this.metadataStore.save();
      }),
    );

    await this.logger.info("Extracted zip");

    const newTreeFiles = this.buildTreeFiles(files);
    // Add files that are in the manifest but not in the tree.
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return !Object.keys(files).contains(filePath);
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content: await this.readLocalContent(filePath),
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from local files");
    const newTreeFiles = this.buildTreeFiles(files);
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          return (
            !this.metadataStore.data.files[filePath].deleted &&
            !this.isIgnored(filePath)
          );
        })
        .map(async (filePath: string) => {
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content: await this.readLocalContent(filePath),
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  // ---------------------------------------------------------------------------
  // Advanced operations
  // ---------------------------------------------------------------------------

  /**
   * Two-way sync: uploads local changes and downloads remote changes.
   */
  async sync(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Syncing", () =>
      this.runSyncImpl("both", options),
    );
  }

  /**
   * Pull only: downloads remote changes without uploading anything.
   */
  async pull(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Pulling", () =>
      this.runSyncImpl("pull", options),
    );
  }

  /**
   * Push only: uploads local changes without downloading anything.
   */
  async push(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Pushing", () =>
      this.runSyncImpl("push", options),
    );
  }

  /**
   * Resolves the first sync when both sides contain files.
   *
   * - `remote`: overwrite local with the remote content (force pull)
   * - `local`: overwrite remote with the local content (force push)
   * - `merge`: keep both sides, conflicting files are handled by the
   *   configured conflict strategy
   */
  async bootstrap(
    mode: "remote" | "local" | "merge",
    options: OperationOptions = {},
  ): Promise<boolean> {
    switch (mode) {
      case "remote":
        return await this.forcePull(options);
      case "local":
        return await this.forcePush(options);
      case "merge":
      default:
        return await this.mergeBootstrap(options);
    }
  }

  /**
   * Force pull: makes the local vault identical to the remote repository.
   * Local files that do not exist remotely are deleted.
   */
  async forcePull(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Force pulling", () =>
      this.forcePullImpl(options),
    );
  }

  private async forcePullImpl(options: OperationOptions) {
    await this.logger.info("Starting force pull");
    if (options.createBackup ?? this.settings.autoBackupOnForce) {
      await this.createBackupRefIfPossible();
    }

    const { files } = await this.client.getRepoContent({ retry: true });
    this.removeLogFileFromFiles(files);

    const manifest = files[this.manifestPath];
    const remoteMetadata = manifest
      ? await this.readRemoteMetadata(manifest.sha)
      : null;

    // Delete local files that are not present in the remote repository.
    await Promise.all(
      Object.keys(this.metadataStore.data.files).map(async (filePath) => {
        if (filePath === this.manifestPath) {
          return;
        }
        if (this.isIgnored(filePath)) {
          return;
        }
        if (files[filePath]) {
          return;
        }
        const normalizedPath = normalizePath(filePath);
        if (await this.vault.adapter.exists(normalizedPath)) {
          await this.vault.adapter.remove(normalizedPath);
          await this.logger.info("Deleted local file", filePath);
        }
        delete this.metadataStore.data.files[filePath];
      }),
    );

    // Download every remote file, unconditionally.
    await Promise.all(
      Object.keys(files).map(async (filePath) => {
        if (filePath === this.manifestPath) {
          return;
        }
        if (this.isIgnored(filePath)) {
          return;
        }
        await this.downloadFile(
          files[filePath],
          remoteMetadata?.files[filePath]?.lastModified ?? Date.now(),
          true,
        );
      }),
    );

    const manifestMetadata = this.metadataStore.data.files[this.manifestPath] ?? {
      path: this.manifestPath,
      sha: null,
      dirty: false,
      justDownloaded: false,
      lastModified: Date.now(),
    };
    manifestMetadata.sha = manifest?.sha ?? null;
    manifestMetadata.deleted = false;
    manifestMetadata.justDownloaded = false;
    this.metadataStore.data.files[this.manifestPath] = manifestMetadata;
    this.metadataStore.data.lastSync = Date.now();
    await this.metadataStore.save();
    await this.logger.info("Force pull done");
  }

  /**
   * Force push: replaces the remote repository content with the local files.
   * Files that only exist remotely are removed.
   */
  async forcePush(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Force pushing", () =>
      this.forcePushImpl(options),
    );
  }

  private async forcePushImpl(options: OperationOptions) {
    await this.logger.info("Starting force push");
    if (options.createBackup ?? this.settings.autoBackupOnForce) {
      await this.createBackupRefIfPossible();
    }

    const localPaths = await this.collectLocalFiles();

    // Rebuild the metadata so it tracks exactly the local files.
    const newFiles: { [key: string]: FileMetadata } = {};
    for (const filePath of localPaths) {
      const existing = this.metadataStore.data.files[filePath];
      newFiles[filePath] = existing
        ? { ...existing, deleted: false }
        : {
            path: filePath,
            sha: null,
            dirty: false,
            justDownloaded: false,
            lastModified: Date.now(),
          };
    }
    newFiles[this.manifestPath] = this.metadataStore.data.files[
      this.manifestPath
    ] ?? {
      path: this.manifestPath,
      sha: null,
      dirty: false,
      justDownloaded: false,
      lastModified: Date.now(),
    };
    this.metadataStore.data.files = newFiles;

    const treeFiles: { [key: string]: NewTreeRequestItem } = {};
    for (const filePath of localPaths) {
      treeFiles[filePath] = {
        path: filePath,
        mode: "100644",
        type: "blob",
        content: await this.readLocalContent(filePath),
      };
    }
    treeFiles[this.manifestPath] = {
      path: this.manifestPath,
      mode: "100644",
      type: "blob",
      content: JSON.stringify(this.metadataStore.data),
    };

    // Passing a null base tree replaces the whole remote tree.
    await this.commitSync(
      treeFiles,
      null,
      [],
      this.resolveCommitMessage(options, "Force push"),
    );
  }

  /**
   * Handles the first sync when both sides have files and there is no shared
   * manifest. Files present on both sides with different content are treated
   * as conflicts, files on one side only are pushed or pulled.
   */
  async mergeBootstrap(options: OperationOptions = {}): Promise<boolean> {
    return await this.runWithNotice("Merging", () =>
      this.mergeBootstrapImpl(options),
    );
  }

  private async mergeBootstrapImpl(options: OperationOptions) {
    await this.logger.info("Starting merge bootstrap");
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    this.removeLogFileFromFiles(files);

    const localPaths = new Set(await this.collectLocalFiles());
    const remotePaths = new Set(
      Object.keys(files).filter(
        (filePath) => filePath !== this.manifestPath && !this.isIgnored(filePath),
      ),
    );

    const allPaths = new Set<string>([...localPaths, ...remotePaths]);
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflictedPaths: string[] = [];

    for (const filePath of allPaths) {
      const localExists = localPaths.has(filePath);
      const remoteFile = files[filePath];
      if (localExists && remoteFile) {
        const localSHA = await this.calculateSHA(filePath);
        if (localSHA === remoteFile.sha) {
          // Identical on both sides, nothing to do.
          continue;
        }
        conflictedPaths.push(filePath);
      } else if (!localExists && remoteFile) {
        downloads.push(filePath);
      } else if (localExists && !remoteFile) {
        uploads.push(filePath);
      }
    }

    const conflicts = await this.loadConflictContents(conflictedPaths, files);
    const conflictResolutions: ConflictResolution[] = [];
    const conflictUploads: string[] = [];
    const conflictDownloads: string[] = [];

    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts during merge", conflicts);
      if (this.settings.conflictHandling === "overwriteLocal") {
        conflictDownloads.push(...conflictedPaths);
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        conflictUploads.push(...conflictedPaths);
      } else {
        const resolutions = await this.onConflicts(conflicts);
        conflictResolutions.push(...resolutions);
        conflictUploads.push(...resolutions.map((r) => r.filePath));
      }
    }

    const treeFiles = this.buildTreeFiles(files);
    await this.applyUploads(treeFiles, [...uploads, ...conflictUploads], conflictResolutions);

    await Promise.all([
      ...downloads.map((filePath) =>
        this.downloadFile(files[filePath], Date.now(), true),
      ),
      ...conflictDownloads.map((filePath) =>
        this.downloadFile(files[filePath], Date.now(), true),
      ),
    ]);

    await this.commitSync(
      treeFiles,
      treeSha,
      conflictResolutions,
      this.resolveCommitMessage(options, "First sync (merge)"),
    );
  }

  /**
   * Computes the current status without applying any change.
   */
  async status(): Promise<SyncStatus> {
    const { files } = await this.client.getRepoContent({ retry: true });
    this.removeLogFileFromFiles(files);

    const manifest = files[this.manifestPath];
    const remoteFileCount = Object.keys(files).filter(
      (filePath) => filePath !== this.manifestPath && !this.isIgnored(filePath),
    ).length;
    const localFileCount = Object.keys(this.metadataStore.data.files).filter(
      (filePath) =>
        filePath !== this.manifestPath &&
        !this.metadataStore.data.files[filePath].deleted &&
        !this.isIgnored(filePath),
    ).length;

    if (manifest === undefined) {
      // No shared manifest yet, so report a naive diff between both sides.
      const uploads: SyncAction[] = [];
      const downloads: SyncAction[] = [];
      const conflictedPaths: string[] = [];

      for (const filePath of Object.keys(files)) {
        if (filePath === this.manifestPath || this.isIgnored(filePath)) {
          continue;
        }
        const normalizedPath = normalizePath(filePath);
        if (!(await this.vault.adapter.exists(normalizedPath))) {
          downloads.push({ type: "download", filePath });
          continue;
        }
        const localSHA = await this.calculateSHA(filePath);
        if (localSHA !== files[filePath].sha) {
          conflictedPaths.push(filePath);
        }
      }

      for (const filePath of Object.keys(this.metadataStore.data.files)) {
        if (filePath === this.manifestPath || this.isIgnored(filePath)) {
          continue;
        }
        if (this.metadataStore.data.files[filePath].deleted) {
          continue;
        }
        if (files[filePath]) {
          continue;
        }
        if (await this.vault.adapter.exists(normalizePath(filePath))) {
          uploads.push({ type: "upload", filePath });
        }
      }

      const conflicts = await this.loadConflictContents(conflictedPaths, files);
      return {
        uploads,
        downloads,
        conflicts,
        hasRemoteManifest: false,
        remoteFileCount,
        localFileCount,
      };
    }

    const remoteMetadata = await this.readRemoteMetadata(manifest.sha);
    const conflicts = await this.findConflicts(remoteMetadata.files);
    const actions = await this.determineSyncActions(
      remoteMetadata.files,
      this.metadataStore.data.files,
      conflicts.map((c) => c.filePath),
    );

    return {
      uploads: actions.filter(
        (action) => action.type === "upload" || action.type === "delete_remote",
      ),
      downloads: actions.filter(
        (action) =>
          action.type === "download" || action.type === "delete_local",
      ),
      conflicts,
      hasRemoteManifest: true,
      remoteFileCount,
      localFileCount,
    };
  }

  /**
   * Creates a backup branch pointing at the current branch head.
   *
   * @returns The name of the created branch, or null when it could not be created.
   */
  async createBackupRefIfPossible(
    prefix = "gitless-backup",
  ): Promise<string | null> {
    try {
      const sha = await this.client.getBranchHeadSha({ retry: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace(/Z$/, "");
      const branchName = `${prefix}-${stamp}`;
      await this.client.createRef({
        ref: `refs/heads/${branchName}`,
        sha,
        retry: true,
      });
      await this.logger.info("Created backup branch", branchName);
      return branchName;
    } catch (err) {
      // The repository may be empty (no branch head yet), a backup is not
      // needed in that case. Any other error we log but don't block the sync.
      await this.logger.warn("Could not create backup branch", err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Core sync implementation
  // ---------------------------------------------------------------------------

  private async runSyncImpl(
    direction: SyncDirection,
    options: OperationOptions,
  ) {
    await this.logger.info("Starting sync", { direction });
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    this.removeLogFileFromFiles(files);

    const manifest = files[this.manifestPath];
    if (manifest === undefined) {
      await this.logger.error("Remote manifest is missing");
      throw new Error(
        "Remote manifest is missing. Use Force pull, Force push or a first sync option.",
      );
    }

    const remoteMetadata = await this.readRemoteMetadata(manifest.sha);
    const conflicts = await this.findConflicts(remoteMetadata.files);
    const { conflictActions, conflictResolutions } =
      await this.resolveConflicts(conflicts, direction);

    let actions = await this.determineSyncActions(
      remoteMetadata.files,
      this.metadataStore.data.files,
      conflictActions.map((action) => action.filePath),
    );
    actions = [...actions, ...conflictActions];
    actions = this.filterActionsByDirection(actions, direction);

    if (actions.length === 0) {
      await this.logger.info("Nothing to sync");
      return;
    }
    await this.logger.info("Actions to sync", actions);

    const treeFiles = this.buildTreeFiles(files);
    const uploadPaths = actions
      .filter((action) => action.type === "upload")
      .map((action) => action.filePath);
    const deleteRemotePaths = actions
      .filter((action) => action.type === "delete_remote")
      .map((action) => action.filePath);
    const downloadPaths = actions
      .filter((action) => action.type === "download")
      .map((action) => action.filePath);
    const deleteLocalPaths = actions
      .filter((action) => action.type === "delete_local")
      .map((action) => action.filePath);

    await this.applyUploads(treeFiles, uploadPaths, conflictResolutions);
    this.applyDeleteRemote(treeFiles, deleteRemotePaths);

    await Promise.all([
      ...downloadPaths.map((filePath) =>
        this.downloadFile(
          files[filePath],
          remoteMetadata.files[filePath]?.lastModified ?? Date.now(),
          true,
        ),
      ),
      ...deleteLocalPaths.map((filePath) => this.deleteLocalFile(filePath)),
    ]);

    if (direction === "pull") {
      // Pull is a local only operation, do not create a remote commit.
      await this.metadataStore.save();
      await this.logger.info("Sync done", { direction });
      return;
    }

    await this.commitSync(
      treeFiles,
      treeSha,
      conflictResolutions,
      this.resolveCommitMessage(options, "Sync"),
    );
  }

  private filterActionsByDirection(
    actions: SyncAction[],
    direction: SyncDirection,
  ): SyncAction[] {
    if (direction === "both") {
      return actions;
    }
    if (direction === "pull") {
      return actions.filter(
        (action) =>
          action.type === "download" || action.type === "delete_local",
      );
    }
    return actions.filter(
      (action) => action.type === "upload" || action.type === "delete_remote",
    );
  }

  private async resolveConflicts(
    conflicts: ConflictFile[],
    direction: SyncDirection,
  ): Promise<{
    conflictActions: SyncAction[];
    conflictResolutions: ConflictResolution[];
  }> {
    if (conflicts.length === 0) {
      return { conflictActions: [], conflictResolutions: [] };
    }
    await this.logger.warn("Found conflicts", conflicts);

    if (direction === "push") {
      // Local wins on push.
      return {
        conflictActions: conflicts.map(
          (conflict): SyncAction => ({
            type: "upload",
            filePath: conflict.filePath,
          }),
        ),
        conflictResolutions: [],
      };
    }
    if (direction === "pull") {
      // Remote wins on pull.
      return {
        conflictActions: conflicts.map(
          (conflict): SyncAction => ({
            type: "download",
            filePath: conflict.filePath,
          }),
        ),
        conflictResolutions: [],
      };
    }

    switch (this.settings.conflictHandling) {
      case "overwriteLocal":
        return {
          conflictActions: conflicts.map(
            (conflict): SyncAction => ({
              type: "download",
              filePath: conflict.filePath,
            }),
          ),
          conflictResolutions: [],
        };
      case "overwriteRemote":
        return {
          conflictActions: conflicts.map(
            (conflict): SyncAction => ({
              type: "upload",
              filePath: conflict.filePath,
            }),
          ),
          conflictResolutions: [],
        };
      case "ask":
      default: {
        // Here we block the sync process until the user has resolved all the conflicts
        const conflictResolutions = await this.onConflicts(conflicts);
        return {
          conflictActions: conflictResolutions.map(
            (resolution): SyncAction => ({
              type: "upload",
              filePath: resolution.filePath,
            }),
          ),
          conflictResolutions,
        };
      }
    }
  }

  private buildTreeFiles(files: {
    [key: string]: GetTreeResponseItem;
  }): { [key: string]: NewTreeRequestItem } {
    const treeFiles: { [key: string]: NewTreeRequestItem } = {};
    for (const filePath of Object.keys(files)) {
      treeFiles[filePath] = {
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      };
    }
    return treeFiles;
  }

  private async applyUploads(
    treeFiles: { [key: string]: NewTreeRequestItem },
    uploadPaths: string[],
    conflictResolutions: ConflictResolution[],
  ) {
    await Promise.all(
      uploadPaths.map(async (filePath) => {
        const resolution = conflictResolutions.find(
          (c) => c.filePath === filePath,
        );
        const content =
          resolution?.content ?? (await this.readLocalContent(filePath));
        treeFiles[filePath] = {
          path: filePath,
          mode: "100644",
          type: "blob",
          content,
        };
      }),
    );
  }

  private applyDeleteRemote(
    treeFiles: { [key: string]: NewTreeRequestItem },
    deletePaths: string[],
  ) {
    for (const filePath of deletePaths) {
      if (treeFiles[filePath]) {
        treeFiles[filePath].sha = null;
      }
    }
  }

  private async readLocalContent(filePath: string): Promise<string> {
    const normalizedPath = normalizePath(filePath);
    // We need to check whether the file is a text file or not before
    // reading it here because trying to read a binary file as text fails
    // on iOS, and probably on other mobile devices too.
    // It's fine to return a bogus content for binary files: when committing
    // the sync we upload the actual blob if the file needs to be synced.
    if (!hasTextExtension(normalizedPath)) {
      return "binaryfile";
    }
    return await this.vault.adapter.read(normalizedPath);
  }

  private removeLogFileFromFiles(files: {
    [key: string]: GetTreeResponseItem;
  }) {
    const logPath = `${this.vault.configDir}/${LOG_FILE_NAME}`;
    if (Object.keys(files).contains(logPath)) {
      // We don't want to download the log file if the user synced it in the past.
      delete files[logPath];
    }
  }

  private async readRemoteMetadata(manifestSha: string): Promise<Metadata> {
    const blob = await this.client.getBlob({ sha: manifestSha, retry: true });
    return JSON.parse(decodeBase64String(blob.content));
  }

  private resolveCommitMessage(
    options: OperationOptions,
    fallback: string,
  ): string {
    const message = options.commitMessage?.trim() || this.settings.commitMessage;
    return message?.trim() ? message.trim() : fallback;
  }

  private commitMessage(): string {
    return this.settings.commitMessage?.trim() || "Sync";
  }

  // ---------------------------------------------------------------------------
  // Diffing
  // ---------------------------------------------------------------------------

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === this.manifestPath) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this
          return null;
        }
        if (this.isIgnored(filePath)) {
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        const actualLocalSHA = await this.calculateSHA(filePath);
        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata SHA is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          remoteFileHasBeenModifiedSinceLastSync &&
          localFileHasBeenModifiedSinceLastSync &&
          actualFilesAreDifferent
        ) {
          return filePath;
        }
        return null;
      }),
    );

    const conflictedPaths = conflicts.filter(
      (filePath): filePath is string => filePath !== null,
    );
    return await Promise.all(
      conflictedPaths.map(async (filePath: string) => {
        // Load contents in parallel
        const [remoteContent, localContent] = await Promise.all([
          await (async () => {
            const res = await this.client.getBlob({
              sha: filesMetadata[filePath].sha!,
              retry: true,
              maxRetries: 1,
            });
            return decodeBase64String(res.content);
          })(),
          await this.readLocalContent(filePath).catch(() => ""),
        ]);
        return {
          filePath,
          remoteContent,
          localContent,
        };
      }),
    );
  }

  /**
   * Loads the remote and local content for the given file paths.
   */
  private async loadConflictContents(
    filePaths: string[],
    files: { [key: string]: GetTreeResponseItem },
  ): Promise<ConflictFile[]> {
    return await Promise.all(
      filePaths.map(async (filePath) => {
        const remoteFile = files[filePath];
        const remoteContent = remoteFile
          ? await this.client
              .getBlob({ sha: remoteFile.sha, retry: true, maxRetries: 1 })
              .then((res) => decodeBase64String(res.content))
          : "";
        const localContent = await this.readLocalContent(filePath).catch(
          () => "",
        );
        return { filePath, remoteContent, localContent };
      }),
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath))
      .filter((filePath) => !this.isIgnored(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === this.manifestPath) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);
        if (remoteFile.sha === localSHA) {
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          return;
        }

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }

        // For non-deletion cases, if SHAs differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localSHA !== localFile.sha) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      if (this.isIgnored(filePath)) {
        return;
      }
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      if (this.isIgnored(filePath)) {
        return;
      }
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    if (!this.settings.syncConfigDir) {
      // Remove all actions that involve the config directory if the user doesn't want to sync it.
      // The manifest file is always synced.
      return actions.filter((action: SyncAction) => {
        return (
          !action.filePath.startsWith(this.vault.configDir) ||
          action.filePath === this.manifestPath
        );
      });
    }

    return actions;
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(filePath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(filePath);
    const contentBytes = new Uint8Array(contentBuffer);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree.
   *                    When null the remote tree is fully replaced.
   * @param conflictResolutions list of conflicts between remote and local files
   * @param commitMessage message to use for the commit
   */
  async commitSync(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string | null,
    conflictResolutions: ConflictResolution[] = [],
    commitMessage: string = "Sync",
  ) {
    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    // to the the same time as the sync time.
    conflictResolutions.forEach((resolution) => {
      const metadata = this.metadataStore.data.files[resolution.filePath];
      if (metadata) {
        metadata.lastModified = syncTime;
      }
    });

    // We want the remote metadata file to track the correct SHA for each file blob,
    // so just before we upload any file we update all their SHAs in the metadata file.
    // This also makes it easier to handle conflicts.
    //
    // In here we also upload blob is file is a binary. We do it here because when uploading a blob we
    // also get back its SHA, so we can set it together with other files.
    // We also do that right before creating the new tree because we need the SHAs of those blob to
    // correctly create it.
    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content !== undefined)
        .map(async (filePath: string) => {
          // Make sure the metadata has an entry for the file, this can happen
          // when forcing a push and the file was never tracked before.
          if (!this.metadataStore.data.files[filePath]) {
            this.metadataStore.data.files[filePath] = {
              path: filePath,
              sha: null,
              dirty: false,
              justDownloaded: false,
              lastModified: Date.now(),
            };
          }

          // I don't fully trust file extensions as they're not completely reliable
          // to determine the file type, though I feel it's ok to compromise and rely
          // on them if it makes the plugin handle upload better on certain devices.
          if (hasTextExtension(filePath)) {
            const sha = await this.calculateSHA(filePath);
            this.metadataStore.data.files[filePath].sha = sha;
            return;
          }

          // We can't upload binary files by setting the content of a tree item,
          // we first need to create a Git blob by uploading the file, then
          // we must update the tree item to point the SHA to the blob we just created.
          const buffer = await this.vault.adapter.readBinary(filePath);
          const { sha } = await this.client.createBlob({
            content: arrayBufferToBase64(buffer),
            retry: true,
            maxRetries: 3,
          });
          await this.logger.info("Created blob", filePath);
          treeFiles[filePath].sha = sha;
          // Can't have both sha and content set, so we delete it
          delete treeFiles[filePath].content;
          this.metadataStore.data.files[filePath].sha = sha;
        }),
    );

    // Update manifest in list of new tree items
    if (!treeFiles[this.manifestPath]) {
      treeFiles[this.manifestPath] = {
        path: this.manifestPath,
        mode: "100644",
        type: "blob",
      };
    }
    delete treeFiles[this.manifestPath].sha;
    treeFiles[this.manifestPath].content = JSON.stringify(
      this.metadataStore.data,
    );

    // Create the new tree. When the base tree is null the remote tree is
    // fully replaced, that's what force push does.
    const newTree: { tree: NewTreeRequestItem[]; base_tree?: string } = {
      tree: Object.keys(treeFiles).map(
        (filePath: string) => treeFiles[filePath],
      ),
    };
    if (baseTreeSha !== null) {
      newTree.base_tree = baseTreeSha;
    }
    const newTreeSha = await this.client.createTree({
      tree: newTree,
      retry: true,
    });

    const branchHeadSha = await this.client.getBranchHeadSha({ retry: true });

    const commitSha = await this.client.createCommit({
      message: commitMessage,
      treeSha: newTreeSha,
      parent: branchHeadSha,
    });

    await this.client.updateBranchHead({ sha: commitSha, retry: true });

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        // Even though we set the last modified timestamp for all files with conflicts
        // just before pushing the changes to remote we do it here again because the
        // write right above would overwrite that.
        const metadata = this.metadataStore.data.files[resolution.filePath];
        if (metadata) {
          metadata.lastModified = syncTime;
        }
      }),
    );
    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    await this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async downloadFile(
    file: GetTreeResponseItem,
    lastModified: number,
    force = false,
  ) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (!force && fileMetadata && fileMetadata.sha === file.sha) {
      // File already exists and has the same SHA, no need to download it again.
      return;
    }
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    const normalizedPath = normalizePath(file.path);
    const fileFolder = normalizePath(
      normalizedPath.split("/").slice(0, -1).join("/"),
    );
    if (!(await this.vault.adapter.exists(fileFolder))) {
      await this.vault.adapter.mkdir(fileFolder);
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(blob.content),
    );
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
      deleted: false,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    if (await this.vault.adapter.exists(normalizedPath)) {
      await this.vault.adapter.remove(normalizedPath);
    }
    const metadata = this.metadataStore.data.files[filePath];
    if (metadata) {
      metadata.deleted = true;
      metadata.deletedAt = Date.now();
    } else {
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
        deleted: true,
        deletedAt: Date.now(),
      };
    }
    await this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      const files = await this.collectLocalFiles();
      files.forEach((filePath: string) => {
        if (filePath === `${this.vault.configDir}/workspace.json`) {
          // Obsidian recommends not syncing the workspace file
          return;
        }

        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      });

      // Must be the first time we run, initialize the metadata store
      // with itself and all files in the vault.
      this.metadataStore.data.files[this.manifestPath] = {
        path: this.manifestPath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      await this.metadataStore.save();
    }
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    // Add them to the metadata store
    files.forEach((filePath: string) => {
      if (this.isIgnored(filePath)) {
        return;
      }
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    });
    await this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === this.manifestPath) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    await this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GitHubSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
