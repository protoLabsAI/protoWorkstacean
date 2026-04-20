Run the agent roll call smoke test. Reports status of all agents (in-process DeepAgents, A2A external services), AI infrastructure, media stack, and monitoring services.

## Steps

1. Run `bash /home/josh/dev/protoWorkstacean/scripts/agent-rollcall.sh`
2. Report the output to the user
3. If any services are down, suggest remediation steps

## Note

The script lives in this repo (`scripts/agent-rollcall.sh`) so the agent roster stays in sync with `workspace/agents/*.yaml` and the in-process DeepAgent runtime. Do not call any other copy.
