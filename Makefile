.PHONY: up down reset logs ps config graph-status

up:
	docker compose up --build -d

down:
	docker compose down

reset:
	docker compose down -v --remove-orphans
	docker compose up --build -d

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

config:
	docker compose config

graph-status:
	docker compose exec postgres psql -U "$${POSTGRES_USER:-linearmemory}" -d "$${POSTGRES_DB:-linearmemory}" -c "SELECT * FROM graph.status();"
