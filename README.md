# InServiceBE

## Stack

- [GitHub .gitignore for Node](https://github.com/github/gitignore/blob/main/Node.gitignore)
- [GitHub .gitignore for Firebase](https://github.com/github/gitignore/blob/main/Firebase.gitignore)

## Getting Started

```bash
cd ~/code
git clone https://github.com/mcneilltc/InServiceBE
cd InServiceBE
npm install
npm run dev
```

If you encounter errors when running `npm run dev`, it may be because **Firebase** is not initalized
on your system.

## Changes

- Added .gitignore from GitHub for Node and Firebase to avoid committing unnecessary files created
on build, logs, deploy, and debugging
- Stopped tracking the `node_modules` folder, which should save space in repository. To do so, I
used `git rm -r --cached node_modules/` in the terminal and committed the changes.
