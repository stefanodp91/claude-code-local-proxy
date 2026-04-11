
📋 EXISTING PLAN IN THIS WORKSPACE

A plan file already exists at {{planPath}} (modified {{mtimeRelative}}).
Its current content is shown below. Decide based on the user's latest message:

  • If the user is REFINING this plan (follow-up, addition, fix, extension),
    call workspace(action="write", path="{{planPath}}", content="<full updated content>").
    Rewrite the WHOLE content — workspace.write replaces the file entirely.

  • If the user is asking for a DIFFERENT topic, create a new plan file with
    a fresh kebab-slug filename.

─── BEGIN CURRENT PLAN CONTENT ───
{{planContent}}
─── END CURRENT PLAN CONTENT ───
