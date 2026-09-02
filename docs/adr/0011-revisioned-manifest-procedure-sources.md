# Procedure sources use one revisioned manifest

World and Agents discover a procedure corpus from the same validated manifest, then fetch only documents they use. The manifest publishes each document's path and the immutable Git revision containing it; Procedure Runs retain that revision and resolved path so later reads cannot drift when the source changes. Human index scraping, filename inference, eager whole-corpus loading, and silent fallback discovery are deliberately excluded because each creates a second source of truth or hides a broken publisher.
