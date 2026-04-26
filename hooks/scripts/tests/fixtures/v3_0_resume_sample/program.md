<!-- automation-policy-v1 -->
## Automation Policy

- Outer Loop는 diminishing-returns 감지 시 session.yaml.outer_loop.auto_trigger가
  true면 자동 실행. AskUserQuestion은 outer 완료 후 Q(v) 악화 또는 세션 종료 기준
  충족 시에만.

<!-- /automation-policy-v1 -->

# Test goal: v3.0 backward-compat resume

This program.md is intentionally minimal — used only for resume.md Step 3.5
version-gate routing tests. The full v3.0 prepare.py / strategy.yaml flow
is not exercised here.
