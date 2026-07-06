/**
 * Project-directory contract between the integration plugins (lib/) and the
 * app's ProjectRegistry (src/plugins/project-registry.ts). The registry is
 * constructed at the composition root and handed to plugins; plugins only
 * ever see this surface, so lib stays free of src imports.
 */

export interface RegistryProject {
  /** Stable project id from the served registry. */
  id: string;
  /** Human-readable project name from the served registry. */
  name: string;
  /** Topic-safe slug derived from name (lowercase, non-alphanum → "-"). */
  slug: string;
  /** Absolute filesystem path to the project directory. */
  path: string;
  /** Native field, or derived from `<path>/.git/config` `[remote "origin"]` url. */
  github?: { owner: string; repo: string };
  /** Native field, or derived from `<path>/.git/refs/remotes/origin/HEAD` symref. */
  defaultBranch?: string;
}

export interface ProjectDirectory {
  getProjects(): readonly RegistryProject[];
  getBySlug(slug: string): RegistryProject | undefined;
  /** Lookup by "owner/repo" (case-insensitive on the registry side). */
  getByGithub(ownerRepo: string): RegistryProject | undefined;
  /** All known "owner/repo" coordinates. */
  getGithubCoords(): string[];
}
