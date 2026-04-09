INFISICAL := infisical run --domain https://secrets.proto-labs.ai/api --env=prod --

.PHONY: deploy down restart logs build shell

## Start (or rebuild) workstacean with secrets from Infisical
deploy:
	$(INFISICAL) docker compose -f docker-compose.prod.yml up --build -d

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
