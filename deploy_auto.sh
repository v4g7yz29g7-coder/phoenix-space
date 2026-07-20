#!/bin/bash
echo "🐦‍🔥 Автоматический деплой контракта Феникса на Polygon Mumbai"

# 1. Создаём временный кошелёк для деплоя
echo "🔑 Создаю деплой-кошелёк..."
DEPLOY_WALLET=$(node -e "
const ethers = require('ethers');
const wallet = ethers.Wallet.createRandom();
console.log(JSON.stringify({
  address: wallet.address,
  privateKey: wallet.privateKey,
  mnemonic: wallet.mnemonic.phrase
}));
")

DEPLOY_ADDRESS=$(echo $DEPLOY_WALLET | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).address))")
DEPLOY_KEY=$(echo $DEPLOY_WALLET | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).privateKey))")

echo "Адрес деплой-кошелька: $DEPLOY_ADDRESS"
echo ""

# 2. Пробуем получить тестовые MATIC из публичных кранов
echo "🚰 Запрашиваю тестовые MATIC из кранов..."
echo "Адрес: $DEPLOY_ADDRESS"
echo ""

# Кран 1: polygon.technology (основной)
curl -s -X POST "https://faucet.polygon.technology/api/claim" \
  -H "Content-Type: application/json" \
  -d "{\"address\":\"$DEPLOY_ADDRESS\",\"network\":\"mumbai\"}" \
  -o /dev/null -w "Кран 1 (polygon.technology): %{http_code}\n" &

# Кран 2: mumbaifaucet.com (запасной)
curl -s "https://mumbaifaucet.com/api/claim?address=$DEPLOY_ADDRESS" \
  -o /dev/null -w "Кран 2 (mumbaifaucet.com): %{http_code}\n" &

# Кран 3: faucetmatic.xyz (запасной)
curl -s -X POST "https://faucetmatic.xyz/api/faucet" \
  -H "Content-Type: application/json" \
  -d "{\"address\":\"$DEPLOY_ADDRESS\",\"network\":\"mumbai\"}" \
  -o /dev/null -w "Кран 3 (faucetmatic.xyz): %{http_code}\n" &

wait
echo ""

# 3. Ждём токены (обычно до 1 минуты)
echo "⏳ Ожидаю поступления токенов (60 секунд)..."
sleep 60

# 4. Разворачиваем контракт
echo ""
echo "📜 Разворачиваю контракт ArtifactRegistry..."
export DEPLOYER_KEY=$DEPLOY_KEY
node deploy.js 2>&1 | tee deploy_result.txt

# 5. Извлекаем адрес контракта
CONTRACT_ADDR=$(grep -oP '0x[a-fA-F0-9]{40}' deploy_result.txt | tail -1)

if [ -n "$CONTRACT_ADDR" ]; then
  echo ""
  echo "✅ Контракт успешно развёрнут!"
  echo "Адрес контракта: $CONTRACT_ADDR"
  echo "CONTRACT_ADDRESS=$CONTRACT_ADDR" >> .env
  echo ""
  echo "🔗 Проверить контракт: https://mumbai.polygonscan.com/address/$CONTRACT_ADDR"
  echo ""
  echo "💾 Сохрани эти данные (деплой-кошелёк можно удалить после деплоя):"
  echo "  Приватный ключ: $DEPLOY_KEY"
  echo "  Адрес: $DEPLOY_ADDRESS"
else
  echo "❌ Не удалось развернуть контракт. Проверь наличие MATIC на кошельке:"
  echo "   https://mumbai.polygonscan.com/address/$DEPLOY_ADDRESS"
  echo "   Если баланс 0, получи токены вручную на фаусете: https://faucet.polygon.technology/"
fi
