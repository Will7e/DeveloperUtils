// ============================================================
// Provider Routing — the request's requirements, stated to the router
// ============================================================
// The catalog lists which parameters a model supports, and the pickers use that
// to choose a MODEL. Nothing told OpenRouter anything, though, so the provider
// OpenRouter picked for that model was free to ignore a parameter it does not
// implement — and the failure mode is not an error, it is a quieter answer:
//
//   • the tool schemas are dropped and the model replies in prose about what it
//     would have done (the same class of bug as describing a tool it was not
//     offered, one layer down);
//   • `reasoning` is ignored, so a turn that was supposed to think does not,
//     and the reply arrives attributed to a reasoning rung it never used;
//   • `max_tokens` is ignored, so a long edit is cut off mid-file.
//
// `require_parameters: true` is the documented fix: the router only considers
// providers that declare support for every parameter in the request. If none
// qualify it returns an error instead of a degraded answer — which this app can
// now afford, because an error here is a typed failure that the in-request
// failover list and the escalation path both handle. Trading a silent wrong
// answer for a loud recoverable one is the whole arc of this work.
//
// Sent only on requests that CARRY a tool surface. A plain chat turn asks for
// nothing that a provider is likely to drop (temperature and max_tokens are
// universal), and stating a requirement with no requirement in it would narrow
// the routing pool for no reason.

/**
 * The `provider` block for a request, or undefined when there is nothing to
 * require.
 *
 * Kept pure and separate from the client so the rule is testable and stated in
 * one place: which requests assert their parameters, and why.
 */
export function providerRouting(input: {
  /** The request carries `tools` (and therefore `tool_choice`) */
  carriesTools: boolean;
}): Record<string, unknown> | undefined {
  if (!input.carriesTools) return undefined;
  return { require_parameters: true };
}
