# Devcon-Swarm-Exporter
CLI tool to build an optimized static export of [devcon app frontend](https://github.com/efdevcon/monorepo/tree/main/devcon-app)

## Requirements
- `node` = `18`
- [httrack](https://github.com/xroche/httrack)

### Install latest Node
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts
node -v
```
### Install httrack
```
sudo apt install httrack
```
### Run a Bee node

#### Option 1 - Swarm Desktop
- https://docs.ethswarm.org/docs/desktop/introduction
#### Option 1 - Run a Bee Light Node
- [https://docs.ethswarm.org/docs/desktop/introduction](https://docs.ethswarm.org/docs/bee/installation/quick-start)

### Install swarm-cli
```
npm i -g @ethersphere/swarm-cli
```

## Usage

### Clone locally

```
git clone https://github.com/w3rkspacelabs/devcon-swarm-exporter.git
cd devcon-swarm-exporter
npm install
npm start
```
output:
```
Usage: devcon-static-exporter [options] [command]

CLI tool to build an optimized static export of devcon app frontend

Options:
  -V, --version   output the version number
  -h, --help      display help for command

Commands:
  clone           Clone the website devcon.org using httrack
  clone-fresh     Deletes existing folder and clones the website devcon.org using httrack
  export          Build an optimised static export
  help [command]  display help for command
```
### Running CLI commands
#### Clone [devcon.org](https://devcon.org/en/) 
```
npm start clone
```
or to delete existing clones and create a fresh clone
```
npm start clone-fresh
```
This clones the website using `httrack` locally to the `./output/devcon-local` folder.

### Run static export rewrites, fixes & optimizations
```
npm start export
```
Running this command should fetch missing resources, optimize the nextjs images and update the relevant urls to make the static export work

### Publishing to Swarm and linking to an ENS Domain

Follow the steps in this blogpost to publish the `./output/devcon-local` folder to Swarm and connect it to an ENS domain

- https://blog.ethswarm.org/foundation/2023/how-to-publish-a-website-on-swarm-using-the-swarm-desktop-app-a-step-by-step-guide/
