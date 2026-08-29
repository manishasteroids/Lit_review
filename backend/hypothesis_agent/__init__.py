"""
Hypothesis Agent -- a separate tool that consumes Sift's literature-review
output, not a module of Sift's own review pipeline (see
hypothesis_agent_architecture.md). Currently reuses Sift's agent classes
directly and shares its process/database -- a deliberate, temporary
shortcut (SS1.1/SS1.2 of the architecture doc) to get something testable
fast, not the finished two-service design. Living in its own top-level
package (rather than inside `pipeline/`) keeps that boundary visible even
while the code is shared, so extracting it into its own service later is a
move, not a rewrite.
"""
