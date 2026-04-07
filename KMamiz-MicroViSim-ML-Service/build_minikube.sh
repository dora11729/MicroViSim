#!/usr/bin/env bash

# Quickly build the Docker image inside minikube's Docker environment
eval $(minikube docker-env)
DOCKER_BUILDKIT=1 docker build . -t kmamiz-ml-sidecar
docker tag kmamiz-ml-sidecar wys899195/kmamiz-ml-sidecar

# Revert to the original Docker environment
eval $(minikube docker-env --unset)