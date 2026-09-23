import { App, Modal, Setting } from "obsidian";
import GitHubSyncPlugin from "src/main";
import { SyncStatus } from "src/sync-manager";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}

class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private options: ConfirmOptions,
    private onResult: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.options.title });
    contentEl.createEl("p", { text: this.options.message });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(this.options.confirmText ?? "Confirm")
          .setWarning()
          .onClick(() => this.finish(true)),
      )
      .addButton((button) =>
        button
          .setButtonText(this.options.cancelText ?? "Cancel")
          .onClick(() => this.finish(false)),
      );
  }

  private finish(value: boolean) {
    this.resolved = true;
    this.onResult(value);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) {
      this.onResult(false);
    }
  }
}

/**
 * Shows a confirmation modal for destructive operations.
 */
export function confirmDestructive(
  app: App,
  options: ConfirmOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}

/**
 * A control panel exposing the advanced git-like operations.
 */
export default class GitOperationsModal extends Modal {
  private statusEl!: HTMLElement;
  private busy = false;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gitless-ops-modal");

    contentEl.createEl("h2", { text: "GitHub Gitless Sync" });
    const settings = this.plugin.settings;
    contentEl.createEl("p", {
      text: `${settings.githubOwner}/${settings.githubRepo} @ ${settings.githubBranch}`,
      cls: "gitless-repo",
    });

    // Commit message
    new Setting(contentEl)
      .setName("Commit message")
      .setDesc("Message used for the commits created by push operations")
      .addText((text) =>
        text
          .setPlaceholder("Sync")
          .setValue(settings.commitMessage)
          .onChange(async (value) => {
            settings.commitMessage = value;
            await this.plugin.saveSettings();
          }),
      );

    // Conflict handling
    const conflictOptions = {
      ask: "Ask",
      overwriteLocal: "Overwrite local file",
      overwriteRemote: "Overwrite remote file",
    };
    new Setting(contentEl)
      .setName("Conflict handling")
      .setDesc("What to do when a file changed both locally and remotely")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(conflictOptions)
          .setValue(settings.conflictHandling)
          .onChange(async (value: keyof typeof conflictOptions) => {
            settings.conflictHandling = value;
            await this.plugin.saveSettings();
          }),
      );

    // Backup toggle
    new Setting(contentEl)
      .setName("Backup branch before force operations")
      .setDesc("Create a branch pointing at the current remote state first")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoBackupOnForce).onChange(async (value) => {
          settings.autoBackupOnForce = value;
          await this.plugin.saveSettings();
        }),
      );

    // Status
    new Setting(contentEl)
      .setName("Status")
      .setDesc("Inspect the differences without applying any change")
      .addButton((button) =>
        button.setButtonText("Refresh").onClick(() => this.refreshStatus()),
      );
    this.statusEl = contentEl.createDiv({ cls: "gitless-status" });

    // Operations
    contentEl.createEl("h3", { text: "Operations" });
    const opsEl = contentEl.createDiv({ cls: "gitless-ops" });

    this.addOperation(opsEl, "Sync", "Two-way sync", "refresh-cw", () =>
      this.plugin.syncManager.sync(),
    );
    this.addOperation(
      opsEl,
      "Pull",
      "Remote changes into local",
      "download",
      () => this.plugin.syncManager.pull(),
    );
    this.addOperation(
      opsEl,
      "Push",
      "Local changes to remote",
      "upload",
      () => this.plugin.syncManager.push(),
    );
    this.addOperation(
      opsEl,
      "Force pull",
      "Overwrite local with remote",
      "alert-triangle",
      () => this.runForce("forcePull"),
      true,
    );
    this.addOperation(
      opsEl,
      "Force push",
      "Overwrite remote with local",
      "alert-triangle",
      () => this.runForce("forcePush"),
      true,
    );

    this.refreshStatus();
  }

  onClose() {
    this.contentEl.empty();
  }

  private addOperation(
    container: HTMLElement,
    name: string,
    description: string,
    icon: string,
    action: () => Promise<unknown>,
    warning = false,
  ) {
    const setting = new Setting(container).setName(name).setDesc(description);
    setting.addButton((button) => {
      button.setIcon(icon).setTooltip(name).onClick(async () => {
        if (this.busy) {
          return;
        }
        this.setBusy(true);
        try {
          await action();
        } finally {
          this.setBusy(false);
          await this.refreshStatus();
        }
      });
      if (warning) {
        button.setWarning();
      }
      return button;
    });
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.statusEl.toggleClass("gitless-busy", busy);
  }

  private async runForce(operation: "forcePull" | "forcePush") {
    const isPull = operation === "forcePull";
    const confirmed = await confirmDestructive(this.app, {
      title: isPull ? "Force pull?" : "Force push?",
      message: isPull
        ? "This will overwrite your local files with the remote repository " +
          "content and delete local files that are not on the remote. " +
          "This cannot be undone."
        : "This will overwrite the remote repository with your local files " +
          "and delete remote files that are not local. " +
          (this.plugin.settings.autoBackupOnForce
            ? "A backup branch will be created first."
            : "No backup branch will be created."),
      confirmText: isPull ? "Force pull" : "Force push",
    });
    if (!confirmed) {
      return;
    }
    if (isPull) {
      await this.plugin.syncManager.forcePull();
    } else {
      await this.plugin.syncManager.forcePush();
    }
  }

  private async refreshStatus() {
    this.statusEl.setText("Loading status...");
    try {
      const status = await this.plugin.syncManager.status();
      this.renderStatus(status);
    } catch (err) {
      this.statusEl.setText(`Failed to load status: ${err}`);
    }
  }

  private renderStatus(status: SyncStatus) {
    this.statusEl.empty();

    if (this.plugin.settings.firstSync) {
      this.renderBootstrap();
      this.statusEl.createEl("hr");
    }

    const summary = this.statusEl.createEl("p", { cls: "gitless-summary" });
    summary.setText(
      `${status.uploads.length} local change(s) to push, ` +
        `${status.downloads.length} remote change(s) to pull, ` +
        `${status.conflicts.length} conflict(s).`,
    );

    this.renderFileList("To push (local → remote)", status.uploads);
    this.renderFileList("To pull (remote → local)", status.downloads);
    this.renderFileList("Conflicts", status.conflicts);

    if (
      status.uploads.length === 0 &&
      status.downloads.length === 0 &&
      status.conflicts.length === 0
    ) {
      this.statusEl.createEl("p", { text: "Everything is in sync." });
    }
  }

  private renderBootstrap() {
    const section = this.statusEl.createDiv({ cls: "gitless-bootstrap" });
    section.createEl("h4", { text: "First sync required" });
    section.createEl("p", {
      text:
        "Both the remote repository and this vault contain files and there is " +
        "no shared sync history yet. Choose how to reconcile them.",
    });
    new Setting(section)
      .addButton((button) =>
        button.setButtonText("Use remote").onClick(async () => {
          await this.plugin.completeBootstrap("remote");
          await this.refreshStatus();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Use local").onClick(async () => {
          await this.plugin.completeBootstrap("local");
          await this.refreshStatus();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Merge").setCta().onClick(async () => {
          await this.plugin.completeBootstrap("merge");
          await this.refreshStatus();
        }),
      );
  }

  private renderFileList(title: string, items: { filePath: string }[]) {
    if (items.length === 0) {
      return;
    }
    const container = this.statusEl.createDiv({ cls: "gitless-file-list" });
    container.createEl("strong", { text: `${title} (${items.length})` });
    const list = container.createEl("ul");
    const limit = 50;
    items.slice(0, limit).forEach((item) => {
      list.createEl("li", { text: item.filePath });
    });
    if (items.length > limit) {
      list.createEl("li", { text: `… and ${items.length - limit} more` });
    }
  }
}
