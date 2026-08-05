cd /var/www/m-bingo

# Build and start all containers
docker-compose -f docker/docker-compose.yml up -d --build

# Check if all containers are running
docker ps

# View logs
docker-compose -f docker/docker-compose.yml logs -f