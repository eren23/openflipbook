"""Matrix bench — the evolvable eval chassis (scenarios x arms x models x
prompt-variants). Pure pieces (_cache, _budget, _record, _pareto) are free-CI
golden-tested; runner.py drives them with injected gen/extract/judge functions
so the whole loop is testable without spending a cent."""
