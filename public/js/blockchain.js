// Модуль блокчейна Феникса
var PhoenixBlockchain = {
  provider: null,
  contract: null,
  contractAddress: null,
  initialized: false,

  // ABI контракта (из deploy.js)
  abi: [
    "function registerArtifact(string memory _id, string memory _title, string memory _author, string memory _contentHash) public",
    "function getArtifact(string memory _id) public view returns (tuple(string id, string title, string author, string contentHash, uint256 timestamp, address creator))",
    "function getAllArtifacts() public view returns (string[] memory)",
    "event ArtifactRegistered(string indexed id, string title, string author, string contentHash, address creator, uint256 timestamp)"
  ],

  // Инициализация с MetaMask или локальным провайдером
  init: async function(contractAddress) {
    this.contractAddress = contractAddress;
    
    // Проверяем, есть ли MetaMask
    if (typeof window.ethereum !== 'undefined') {
      this.provider = new ethers.providers.Web3Provider(window.ethereum);
      await window.ethereum.request({ method: 'eth_requestAccounts' });
    } else {
      // Локальный провайдер (для тестов)
      this.provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
    }
    
    var signer = this.provider.getSigner();
    this.contract = new ethers.Contract(contractAddress, this.abi, signer);
    this.initialized = true;
    
    console.log('🔗 Блокчейн подключён:', contractAddress);
    return true;
  },

  // Сохранить артефакт в блокчейн
  registerArtifact: async function(id, title, author, contentHash) {
    if (!this.initialized) throw new Error('Блокчейн не инициализирован');
    var tx = await this.contract.registerArtifact(id, title, author, contentHash);
    await tx.wait();
    console.log('📜 Артефакт сохранён в блокчейн:', id);
    return tx;
  },

  // Получить артефакт по ID
  getArtifact: async function(id) {
    if (!this.initialized) throw new Error('Блокчейн не инициализирован');
    return await this.contract.getArtifact(id);
  },

  // Получить все артефакты
  getAllArtifacts: async function() {
    if (!this.initialized) throw new Error('Блокчейн не инициализирован');
    var ids = await this.contract.getAllArtifacts();
    var artifacts = [];
    for (var i = 0; i < ids.length; i++) {
      var a = await this.contract.getArtifact(ids[i]);
      artifacts.push(a);
    }
    return artifacts;
  }
};

// Авто-инициализация, если есть MetaMask
if (typeof window.ethereum !== 'undefined') {
  console.log('🦊 MetaMask обнаружен');
}
