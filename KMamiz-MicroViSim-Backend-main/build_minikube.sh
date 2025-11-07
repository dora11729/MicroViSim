#!/usr/bin/env bash

# Quickly build the Docker image inside minikube's Docker environment
eval $(minikube docker-env)
DOCKER_BUILDKIT=1 docker build . -t kmamiz
docker tag kmamiz wys899195/kmamiz

# Revert to the original Docker environment
eval $(minikube docker-env --unset)