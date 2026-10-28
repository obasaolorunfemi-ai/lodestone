/** The models a tool would actually call, in a format an evaluator can read, so it
 *  benchmarks what is in use and not a guess. Naija Eval reads this to say which of
 *  them it has not measured yet. See docs/scorecards.md. */

export const CANDIDATES_SCHEMA = 'model-candidates/1';

export interface Candidate {
  id: string;
  provider: string;
  /** Where it is used: free:fast, free:strong, free:vision, paid, fallback. */
  roles: string[];
}

export interface Candidates {
  schema: typeof CANDIDATES_SCHEMA;
  source: string;
  generatedAt: string;
  models: Candidate[];
}
