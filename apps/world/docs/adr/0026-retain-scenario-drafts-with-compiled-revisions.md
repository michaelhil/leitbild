# Retain Scenario Drafts with compiled revisions

A Scenario Revision stores both its editable Scenario Draft and the exact compiled Scenario Definition. Storing only the Draft would let later Pack-code changes alter an existing revision, while storing only the compiled Definition makes safe editing depend on reverse-engineering runtime objects; the paired immutable record preserves both authorability and reproducible Simulation Runs.
