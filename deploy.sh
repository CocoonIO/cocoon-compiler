#!/bin/bash

PLATFORM='unknown'
UNAMESTR=$(uname)

if [[ "${UNAMESTR}" == 'Linux' ]]; then
   PLATFORM='linux'
elif [[ "${UNAMESTR}" == 'FreeBSD' ]]; then
   PLATFORM='freebsd'
elif [[ "${UNAMESTR}" == 'CYGWIN_NT-10.0' ]]; then
   PLATFORM='windows'
fi

PATH=$PATH:/usr/local/bin/

if [[ "$PLATFORM" == 'windows' ]]; then
    source ~/.bash_profile
fi

ENVIRONMENT="${1}"

if [[ -z "${ENVIRONMENT}" ]]; then
    ENVIRONMENT='testing'
fi

echo "Removing previous build and dependencies"
rm -rf build node_modules

echo "Installing NPM dependencies..."
npm install

echo "Starting PM2 services..."
pm2 startOrRestart ecosystem.json --env "${ENVIRONMENT}"

echo "Saving PM2 state..."
pm2 save
