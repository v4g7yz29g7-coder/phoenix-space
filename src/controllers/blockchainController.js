const { ethers } = require('ethers');

const abi = [
  "function registerArtifact(string memory _id, string memory _title, string memory _author, string memory _contentHash) public",
  "function getArtifact(string memory _id) public view returns (tuple(string id, string title, string author, string contentHash, uint256 timestamp, address creator))",
  "function getAllArtifacts() public view returns (string[] memory)",
  "event ArtifactRegistered(string indexed id, string title, string author, string contentHash, address creator, uint256 timestamp)"
];

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x3D6B3FAE87b6F670990BdE0e57bdD37BdB8b8Adc';
const RPC_URL = process.env.BLOCKCHAIN_RPC || 'http://127.0.0.1:8545';
const PRIVATE_KEY = process.env.BLOCKCHAIN_KEY || '0x6d287de4048ce6ff7cdbb19707ac6f5c04543bd592121bb12e57aaf0261f5a1e';

let provider, wallet, contract;

async function getContract() {
  if (!contract) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
  }
  return contract;
}

exports.registerOnChain = async (req, res) => {
  try {
    const { artifactId, title, author, description } = req.body;
    
    if (!artifactId || !title) {
      return res.status(400).json({ success: false, error: 'ID и название обязательны' });
    }

    // ethers v6: keccak256( toUtf8Bytes( data ) )
    const contentHash = ethers.keccak256(
      ethers.toUtf8Bytes(title + (description || '') + (author || '') + Date.now())
    );
    
    const contract = await getContract();
    const tx = await contract.registerArtifact(artifactId, title, author || 'Аноним', contentHash);
    const receipt = await tx.wait();
    
    res.json({ 
      success: true, 
      data: {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        contractAddress: CONTRACT_ADDRESS,
        artifactId,
        contentHash
      }
    });
  } catch (err) {
    console.error('Blockchain error:', err);
    res.status(500).json({ success: false, error: err.message || 'Ошибка блокчейна' });
  }
};

exports.getArtifactFromChain = async (req, res) => {
  try {
    const contract = await getContract();
    const artifact = await contract.getArtifact(req.params.id);
    
    res.json({
      success: true,
      data: {
        id: artifact.id,
        title: artifact.title,
        author: artifact.author,
        contentHash: artifact.contentHash,
        timestamp: artifact.timestamp.toString(),
        creator: artifact.creator
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getAllFromChain = async (req, res) => {
  try {
    const contract = await getContract();
    const ids = await contract.getAllArtifacts();
    res.json({ success: true, data: ids });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
