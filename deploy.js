const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
  // Конфигурация
  const RPC_URL = process.env.POLYGON_RPC || 'https://rpc-mumbai.maticvigil.com';
  const PRIVATE_KEY = process.env.DEPLOYER_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
  
  if (PRIVATE_KEY === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    console.log('⚠️  Установи переменную окружения DEPLOYER_KEY для деплоя в настоящую сеть.');
    console.log('   Пока контракт будет развёрнут в локальной симуляции.');
    
    // Создаём локального провайдера для теста
    const provider = new ethers.JsonRpcProvider('http://localhost:8545');
    const wallet = ethers.Wallet.createRandom().connect(provider);
    
    const contractABI = JSON.parse(fs.readFileSync('./artifacts/contracts/ArtifactRegistry.sol/ArtifactRegistry.json', 'utf8')).abi;
    const contractBytecode = JSON.parse(fs.readFileSync('./artifacts/contracts/ArtifactRegistry.sol/ArtifactRegistry.json', 'utf8')).bytecode;
    
    const factory = new ethers.ContractFactory(contractABI, contractBytecode, wallet);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    
    console.log('📜 Контракт развёрнут (симуляция) по адресу:', await contract.getAddress());
    return;
  }
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  const contractABI = JSON.parse(fs.readFileSync('./artifacts/contracts/ArtifactRegistry.sol/ArtifactRegistry.json', 'utf8')).abi;
  const contractBytecode = JSON.parse(fs.readFileSync('./artifacts/contracts/ArtifactRegistry.sol/ArtifactRegistry.json', 'utf8')).bytecode;
  
  const factory = new ethers.ContractFactory(contractABI, contractBytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  
  console.log('📜 Контракт развёрнут на Mumbai по адресу:', await contract.getAddress());
  fs.writeFileSync('.env', `CONTRACT_ADDRESS=${await contract.getAddress()}\n`, { flag: 'a' });
}

main().catch(console.error);
