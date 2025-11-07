#!/usr/bin/env bash

# Quickly build the Docker image inside minikube's Docker environment
eval $(minikube docker-env)
docker build . -t kmamiz-web

# Revert to the original Docker environment
eval $(minikube docker-env --unset)