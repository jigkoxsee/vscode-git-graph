import * as fs from 'fs';
import * as vscode from 'vscode';
import { Avatar, AvatarCache } from './avatarManager';
import { Event } from './event';
import { CodeReview, ErrorInfo, FileViewType, GitGraphViewGlobalState, GitRepoSet, GitRepoState, ShowTags } from './types';
import { getPathFromStr, GitExecutable } from './utils';

const AVATAR_STORAGE_FOLDER = '/avatars';
const AVATAR_CACHE = 'avatarCache';
const CODE_REVIEWS = 'codeReviews';
const GLOBAL_VIEW_STATE = 'globalViewState';
const IGNORED_REPOS = 'ignoredRepos';
const LAST_ACTIVE_REPO = 'lastActiveRepo';
const LAST_KNOWN_GIT_PATH = 'lastKnownGitPath';
const REPO_STATES = 'repoStates';

export const DEFAULT_REPO_STATE: GitRepoState = {
	columnWidths: null,
	cdvDivider: 0.5,
	cdvHeight: 250,
	fileViewType: FileViewType.Default,
	issueLinkingConfig: null,
	showRemoteBranches: true,
	showTags: ShowTags.Default,
	hideRemotes: []
};

const DEFAULT_GLOBAL_VIEW_STATE: GitGraphViewGlobalState = {
	alwaysAcceptCheckoutCommit: false,
	issueLinkingConfig: null
};

export interface CodeReviewData {
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}
export type CodeReviews = { [repo: string]: { [id: string]: CodeReviewData } };

/**
 * Manages the Git Graph Extension State, which stores data in both the Visual Studio Code Global & Workspace State.
 */
export class ExtensionState implements vscode.Disposable {
	private readonly globalState: vscode.Memento;
	private readonly workspaceState: vscode.Memento;
	private readonly globalStoragePath: string;
	private avatarStorageAvailable: boolean = false;
	private disposables: vscode.Disposable[] = [];

	/**
	 * Creates the Git Graph Extension State.
	 * @param context The context of the extension.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 */
	constructor(context: vscode.ExtensionContext, onDidChangeGitExecutable: Event<GitExecutable>) {
		this.globalState = context.globalState;
		this.workspaceState = context.workspaceState;

		this.globalStoragePath = getPathFromStr(context.globalStoragePath);
		fs.stat(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
			if (!err) {
				this.avatarStorageAvailable = true;
			} else {
				fs.mkdir(this.globalStoragePath, () => {
					fs.mkdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
						if (!err) this.avatarStorageAvailable = true;
					});
				});
			}
		});

		onDidChangeGitExecutable((gitExecutable) => {
			this.setLastKnownGitPath(gitExecutable.path);
		}, this.disposables);
	}

	/**
	 * Disposes the resources used by the ExtensionState.
	 */
	public dispose() {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}


	/* Known Repositories */

	/**
	 * Get the known repositories in the current workspace.
	 * @returns The set of repositories.
	 */
	public getRepos() {
		const repoSet = this.workspaceState.get<GitRepoSet>(REPO_STATES, {});
		Object.keys(repoSet).forEach(repo => {
			repoSet[repo] = Object.assign({}, DEFAULT_REPO_STATE, repoSet[repo]);
		});
		return repoSet;
	}

	/**
	 * Set the known repositories in the current workspace.
	 * @param gitRepoSet The set of repositories.
	 */
	public saveRepos(gitRepoSet: GitRepoSet) {
		this.updateWorkspaceState(REPO_STATES, gitRepoSet);
	}

	/**
	 * Transfer state references from one known repository to another.
	 * @param oldRepo The repository to transfer state from.
	 * @param newRepo The repository to transfer state to.
	 */
	public transferRepo(oldRepo: string, newRepo: string) {
		if (this.getLastActiveRepo() === oldRepo) {
			this.setLastActiveRepo(newRepo);
		}

		let reviews = this.getCodeReviews();
		if (typeof reviews[oldRepo] !== 'undefined') {
			reviews[newRepo] = reviews[oldRepo];
			delete reviews[oldRepo];
			this.setCodeReviews(reviews);
		}
	}


	/* Global View State */

	/**
	 * Get the global state of the Git Graph View.
	 * @returns The global state.
	 */
	public getGlobalViewState() {
		const globalViewState = this.globalState.get<GitGraphViewGlobalState>(GLOBAL_VIEW_STATE, DEFAULT_GLOBAL_VIEW_STATE);
		return Object.assign({}, DEFAULT_GLOBAL_VIEW_STATE, globalViewState);
	}

	/**
	 * Set the global state of the Git Graph View.
	 * @param state The global state.
	 */
	public setGlobalViewState(state: GitGraphViewGlobalState) {
		return this.updateGlobalState(GLOBAL_VIEW_STATE, state);
	}


	/* Ignored Repos */

	/**
	 * Get the ignored repositories in the current workspace.
	 * @returns An array of the paths of ignored repositories.
	 */
	public getIgnoredRepos() {
		return this.workspaceState.get<string[]>(IGNORED_REPOS, []);
	}

	/**
	 * Set the ignored repositories in the current workspace.
	 * @param ignoredRepos An array of the paths of ignored repositories.
	 */
	public setIgnoredRepos(ignoredRepos: string[]) {
		return this.updateWorkspaceState(IGNORED_REPOS, ignoredRepos);
	}


	/* Last Active Repo */

	/**
	 * Get the last active repository in the current workspace.
	 * @returns The path of the last active repository.
	 */
	public getLastActiveRepo() {
		return this.workspaceState.get<string | null>(LAST_ACTIVE_REPO, null);
	}

	/**
	 * Set the last active repository in the current workspace.
	 * @param repo The path of the last active repository.
	 */
	public setLastActiveRepo(repo: string | null) {
		this.updateWorkspaceState(LAST_ACTIVE_REPO, repo);
	}


	/* Last Known Git Path */

	/**
	 * Get the last known path of the Git executable used by Git Graph.
	 * @returns The path of the Git executable.
	 */
	public getLastKnownGitPath() {
		return this.globalState.get<string | null>(LAST_KNOWN_GIT_PATH, null);
	}

	/**
	 * Set the last known path of the Git executable used by Git Graph.
	 * @param path The path of the Git executable.
	 */
	private setLastKnownGitPath(path: string) {
		this.updateGlobalState(LAST_KNOWN_GIT_PATH, path);
	}


	/* Avatars */

	/**
	 * Checks whether the Avatar Storage Folder is available to store avatars.
	 * @returns TRUE => Avatar Storage Folder is available, FALSE => Avatar Storage Folder isn't available.
	 */
	public isAvatarStorageAvailable() {
		return this.avatarStorageAvailable;
	}

	/**
	 * Gets the path that is used to store avatars globally in Git Graph.
	 * @returns The folder path.
	 */
	public getAvatarStoragePath() {
		return this.globalStoragePath + AVATAR_STORAGE_FOLDER;
	}

	/**
	 * Gets the cache of avatars known to Git Graph.
	 * @returns The avatar cache.
	 */
	public getAvatarCache() {
		return this.globalState.get<AvatarCache>(AVATAR_CACHE, {});
	}

	/**
	 * Add a new avatar to the cache of avatars known to Git Graph.
	 * @param email The email address that the avatar is for.
	 * @param avatar The details of the avatar.
	 */
	public saveAvatar(email: string, avatar: Avatar) {
		let avatars = this.getAvatarCache();
		avatars[email] = avatar;
		this.updateGlobalState(AVATAR_CACHE, avatars);
	}

	/**
	 * Removes an avatar from the cache of avatars known to Git Graph.
	 * @param email The email address of the avatar to remove.
	 */
	public removeAvatarFromCache(email: string) {
		let avatars = this.getAvatarCache();
		delete avatars[email];
		this.updateGlobalState(AVATAR_CACHE, avatars);
	}

	/**
	 * Clear all avatars from the cache of avatars known to Git Graph.
	 */
	public clearAvatarCache() {
		this.updateGlobalState(AVATAR_CACHE, {});
		fs.readdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err, files) => {
			if (err) return;
			for (let i = 0; i < files.length; i++) {
				fs.unlink(this.globalStoragePath + AVATAR_STORAGE_FOLDER + '/' + files[i], () => { });
			}
		});
	}


	/* Code Review */

	// Note: id => the commit arguments to 'git diff' (either <commit hash> or <commit hash>-<commit hash>)

	/**
	 * Start a new Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param files An array of files that must be reviewed.
	 * @param lastViewedFile The last file the user reviewed before starting the Code Review.
	 * @returns The Code Review that was started.
	 */
	public startCodeReview(repo: string, id: string, files: string[], lastViewedFile: string | null) {
		let reviews = this.getCodeReviews();
		if (typeof reviews[repo] === 'undefined') reviews[repo] = {};
		reviews[repo][id] = { lastActive: (new Date()).getTime(), lastViewedFile: lastViewedFile, remainingFiles: files };
		return this.setCodeReviews(reviews).then((err) => ({
			codeReview: <CodeReview>Object.assign({ id: id }, reviews[repo][id]),
			error: err
		}));
	}

	/**
	 * End an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 */
	public endCodeReview(repo: string, id: string) {
		let reviews = this.getCodeReviews();
		removeCodeReview(reviews, repo, id);
		return this.setCodeReviews(reviews);
	}

	/**
	 * Get an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @returns The Code Review.
	 */
	public getCodeReview(repo: string, id: string) {
		let reviews = this.getCodeReviews();
		if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
			reviews[repo][id].lastActive = (new Date()).getTime();
			this.setCodeReviews(reviews);
			return <CodeReview>Object.assign({ id: id }, reviews[repo][id]);
		} else {
			return null;
		}
	}

	/**
	 * Record that a file has been reviewed in a Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param file The file that has been reviewed.
	 */
	public updateCodeReviewFileReviewed(repo: string, id: string, file: string) {
		let reviews = this.getCodeReviews();
		if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
			let i = reviews[repo][id].remainingFiles.indexOf(file);
			if (i > -1) reviews[repo][id].remainingFiles.splice(i, 1);
			if (reviews[repo][id].remainingFiles.length > 0) {
				reviews[repo][id].lastViewedFile = file;
				reviews[repo][id].lastActive = (new Date()).getTime();
			} else {
				removeCodeReview(reviews, repo, id);
			}
			this.setCodeReviews(reviews);
		}
	}

	/**
	 * Delete any Code Reviews that haven't been active during the last 90 days.
	 */
	public expireOldCodeReviews() {
		let reviews = this.getCodeReviews(), change = false, expireReviewsBefore = (new Date()).getTime() - 7776000000; // 90 days x 24 hours x 60 minutes x 60 seconds x 1000 milliseconds
		Object.keys(reviews).forEach((repo) => {
			Object.keys(reviews[repo]).forEach((id) => {
				if (reviews[repo][id].lastActive < expireReviewsBefore) {
					delete reviews[repo][id];
					change = true;
				}
			});
			removeCodeReviewRepoIfEmpty(reviews, repo);
		});
		if (change) this.setCodeReviews(reviews);
	}

	/**
	 * End all Code Reviews in the current workspace.
	 */
	public endAllWorkspaceCodeReviews() {
		this.setCodeReviews({});
	}

	/**
	 * Get all Code Reviews in the current workspace.
	 * @returns The set of Code Reviews.
	 */
	public getCodeReviews() {
		return this.workspaceState.get<CodeReviews>(CODE_REVIEWS, {});
	}

	/**
	 * Set the Code Reviews in the current workspace.
	 * @param reviews The set of Code Reviews.
	 */
	private setCodeReviews(reviews: CodeReviews) {
		return this.updateWorkspaceState(CODE_REVIEWS, reviews);
	}


	/* Update State Memento's */

	/**
	 * Update the Git Graph Global State with a new <key, value> pair.
	 * @param key The key.
	 * @param value The value.
	 */
	private updateGlobalState(key: string, value: any): Thenable<ErrorInfo> {
		return this.globalState.update(key, value).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Global State Memento.'
		);
	}

	/**
	 * Update the Git Graph Workspace State with a new <key, value> pair.
	 * @param key The key.
	 * @param value The value.
	 */
	private updateWorkspaceState(key: string, value: any): Thenable<ErrorInfo> {
		return this.workspaceState.update(key, value).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Workspace State Memento.'
		);
	}
}


/* Helper Methods */

/**
 * Remove a Code Review from a set of Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository the Code Review is in.
 * @param id The ID of the Code Review.
 */
function removeCodeReview(reviews: CodeReviews, repo: string, id: string) {
	if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
		delete reviews[repo][id];
		removeCodeReviewRepoIfEmpty(reviews, repo);
	}
}

/**
 * Remove a repository from a set of Code Reviews if the repository doesn't contain any Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository to perform this action on.
 */
function removeCodeReviewRepoIfEmpty(reviews: CodeReviews, repo: string) {
	if (typeof reviews[repo] !== 'undefined' && Object.keys(reviews[repo]).length === 0) {
		delete reviews[repo];
	}
}
