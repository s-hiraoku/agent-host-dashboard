export interface GitHubRepositoryLocator {
  readonly service: "github";
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly repositoryId?: string;
}

export type RepositoryLocator = GitHubRepositoryLocator;

export interface RepositoryAssociationProvenance {
  readonly source: string;
  readonly confidence: "low" | "medium" | "high";
}

export interface RepositoryCheckoutContext {
  readonly branch?: string;
  readonly worktree?: string;
}

export interface ConfirmedRepositoryAssociation {
  readonly kind: "confirmed";
  readonly agentId: string;
  readonly repository: RepositoryLocator;
  readonly provenance: RepositoryAssociationProvenance;
  readonly checkout?: RepositoryCheckoutContext;
  readonly pullRequest?: { readonly number: number };
}

interface CandidateRepositoryAssociationBase {
  readonly kind: "candidate";
  readonly agentId: string;
  readonly repository: RepositoryLocator;
  readonly provenance: RepositoryAssociationProvenance & { readonly confidence: "low" | "medium" };
}

export interface RepositoryMatchCandidate extends CandidateRepositoryAssociationBase {
  readonly reason: "repository_match";
  readonly checkout?: RepositoryCheckoutContext;
}

export interface BranchMatchCandidate extends CandidateRepositoryAssociationBase {
  readonly reason: "branch_match";
  readonly checkout: RepositoryCheckoutContext & { readonly branch: string };
}

export interface HeuristicMatchCandidate extends CandidateRepositoryAssociationBase {
  readonly reason: "adapter_heuristic";
  readonly checkout?: RepositoryCheckoutContext;
}

export type CandidateRepositoryAssociation = RepositoryMatchCandidate | BranchMatchCandidate | HeuristicMatchCandidate;

export type RepositoryAssociation = ConfirmedRepositoryAssociation | CandidateRepositoryAssociation;

export type RepositoryContextResult =
  | {
      readonly state: "ready";
      readonly associations: readonly RepositoryAssociation[];
      readonly revision?: number;
      readonly freshness?: "current" | "stale";
      readonly complete?: boolean;
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
    }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface SourceControlRepository {
  readonly locator: RepositoryLocator;
  readonly url: string;
  readonly visibility: "public" | "private" | "internal" | "unknown";
  readonly defaultBranch?: string;
}

export interface SourceControlIssue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

export interface SourceControlPullRequest {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly url: string;
  readonly updatedAt: string;
  readonly head: { readonly owner?: string; readonly branch: string };
  readonly checks: "passing" | "failing" | "pending" | "unknown";
  readonly review: "approved" | "changes_requested" | "pending" | "unknown";
}

export type PullRequestRelationship = "associated" | "candidate" | "repository_wide";

export interface RelatedPullRequest {
  readonly pullRequest: SourceControlPullRequest;
  readonly relationship: PullRequestRelationship;
}
