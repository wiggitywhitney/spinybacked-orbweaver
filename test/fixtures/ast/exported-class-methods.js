// ABOUTME: Fixture for testing classifyFunctions with class-based JavaScript (release-it / GitHub class pattern).

import { Octokit } from '@octokit/rest';

export class GitHub {
  constructor(options) {
    this.octokit = new Octokit(options);
  }

  async release() {
    return this.octokit.repos.createRelease({ tag_name: 'v1.0.0' });
  }

  async publishRelease() {
    return this.octokit.repos.updateRelease({ draft: false });
  }

  async getLatestRelease() {
    return this.octokit.repos.getLatestRelease();
  }

  syncHelper(value) {
    return value.trim();
  }
}

export class GitBase {
  async commit(message) {
    return this._exec(['git', 'commit', '-m', message]);
  }

  async push(remoteUrl, branchName) {
    return this._exec(['git', 'push', remoteUrl, branchName]);
  }

  _exec(args) {
    return new Promise((resolve) => resolve(args));
  }
}

class InternalHelper {
  async process(data) {
    return data;
  }
}
