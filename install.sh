#!/bin/bash

  APP_NAME="MDpedia"
  APP_OWNER="yparsak"
  DB_PORT=3306

  GIT_REPO="https://github.com"
  GIT_API="https://api.github.com/repos"

  SRC_PATH="$HOME/src"
  APP_PATH="$SRC_PATH/$APP_NAME"

  if [ -d "$APP_PATH" ]; then
    echo "Path: $APP_PATH"
    echo "Application directory found. Remove or Rename to reinstall it"
    exit 1
  fi

  APP_API_URL="$GIT_API/${APP_OWNER}/${APP_NAME}/releases/latest"

  # -- Download Required Packages
  REQUIRED_PKGS=("build-essential" "nodejs" "npm" "curl" "mariadb-server" "zstd" "openssl")
  MISSING_PKGS=()

  echo "Checking required packages"

  # -- detect missing packages
  for PKG in "${REQUIRED_PKGS[@]}"; do
    if dpkg-query -W -f='${Status}' "$PKG" 2>/dev/null | grep -q "ok installed"; then
      echo "  [>] $PKG is present."
    else
      echo "  [X] $PKG is missing."
      MISSING_PKGS+=("$PKG")
    fi
  done

  if [ ${#MISSING_PKGS[@]} -eq 0 ]; then
    echo "All required packages are already installed. Nothing to do!"
  else
    exit 1
  fi

  # -- Setting up directories
  mkdir -p "${SRC_PATH}"
  mkdir -p "${APP_PATH}"

  RESPONSE=$(curl -sL $APP_API_URL)
  DOWNLOAD_URL=$(echo "$RESPONSE" | grep -oP '"tarball_url":\s*"\K[^"]+')
  TAG_NAME=$(echo "$RESPONSE" | grep -oP '"tag_name":\s*"\K[^"]+')

  if [ -z "$DOWNLOAD_URL" ]; then
      echo "Error: Could not parse the download URL. Check your connection or GitHub API limits."
      exit 1
  fi

  echo "Downloading $DOWNLOAD_URL Tag: $TAG_NAME"

  FILENAME="$APP_NAME-$TAG_NAME.tar.gz"
  FULL_PATH="$APP_PATH/$FILENAME"

  curl -L "$DOWNLOAD_URL" -o "$FULL_PATH"

  if [ -f "$FULL_PATH" ]; then
    tar -zxf "$FULL_PATH" -C "$APP_PATH" --strip-components=1
    if [ $? -eq 0 ]; then
        echo "Extraction successful. Removing archive..."
        rm "$FULL_PATH"
        echo "Version: $TAG_NAME" > ${APP_PATH}/version
    else
        echo "Error: Extraction failed."
        exit 1
    fi
  else
    echo "Error: Download failed."
    exit 1
  fi

  APP_DOTENV="${APP_PATH}/app/.env"
  if [ ! -f "${APP_DOTENV}" ]; then
    if [ -f "${APP_PATH}/.env.example" ]; then
      cat ${APP_PATH}/.env.example > ${APP_PATH}/.env
    fi
  fi

