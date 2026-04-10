INFISICAL_AI  := infisical run --domain https://secrets.proto-labs.ai/api --env=prod --projectId=11e172e0-a1f6-41d5-9464-df72779a7063 --
INFISICAL_IAC := infisical run --domain https://secrets.proto-labs.ai/api --env=prod --projectId=14b0ea3a-ea73-4e21-9b08-0b26e10347de --

# Canonical deployment lives in homelab-iac/stacks/ai (uses both Infisical projects).
# Use this target from /home/josh/dev/homelab-iac/stacks/ai:
#   $(INFISICAL_IAC) $(INFISICAL_AI) docker compose up workstacean --build -d --no-deps
#
# Standalone deployment (no gateway/graphiti, uses ANTHROPIC_API_KEY directly):

.PHONY: deploy down restart logs build shell

## Standalone: start (or rebuild) workstacean with secrets from Infisical AI project
deploy:
	$(INFISICAL_AI) docker compose -f docker-compose.prod.yml up --build -d

## Stop workstacean
down:
	docker compose -f docker-compose.prod.yml down

## Restart without rebuilding
restart:
	docker compose -f docker-compose.prod.yml restart workstacean

## Tail logs
logs:
	docker compose -f docker-compose.prod.yml logs -f workstacean

## Rebuild image without starting
build:
	$(INFISICAL) docker compose -f docker-compose.prod.yml build

## Shell into running container
shell:
	docker compose -f docker-compose.prod.yml exec workstacean sh
