# Evidence comparison

Reader quotes are stored exactly as returned. The selected comparison policy is frozen with each run and recorded alongside validated reader artifacts and in its results.

- `exact-substring-v1`: require an exact nonempty contiguous substring. Historical runs without a policy field retain this behavior.
- `whitespace-quotes-v1`: on both the quote and extracted source, map curly single/double quotation marks to their ASCII counterparts, collapse whitespace runs (including line breaks) to one space, and trim the ends. Require a nonempty contiguous substring after that transformation.

The formatting policy does not change words, numbers, order or letter case. It does not join hyphenated words, remove punctuation, insert ellipses, join a table heading to a separated row, or use fuzzy similarity. It never rewrites the quote or original source. Heading recovery still uses exact verbatim matching.

Changing the policy does not revalidate or rewrite historical results. A new run remains subject to normal human-confirmed spending and activation. Offline checks of retained responses are comparison evidence, not a new classification run.
