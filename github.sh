#!/bin/bash

read -p "Vrei să te conectezi prin SSH la GitHub? (y/n): " use_ssh

if [[ "$use_ssh" == "y" ]]; then
    ssh -T git@github.com

    git remote set-url origin git@github.com:antonndev/ADEdge.git
fi

git add .

git commit -m "ADEdge Update"
git pull --no-rebase

git push --set-upstream origin main
