import ethers from 'ethers';
import express from 'express';
import chalk from 'chalk';
import dotenv from 'dotenv';
import inquirer from 'inquirer';

const app = express();
dotenv.config();

const data = {
  BNB: process.env.BNB_CONTRACT, //bnb

  to_PURCHASE: process.env.TO_PURCHASE, // token that you will purchase = BUSD for test '0xe9e7cea3dedca5984780bafc599bd69add087d56'

  AMOUNT_OF_BNB: process.env.AMOUNT_OF_BNB, // how much you want to buy in BNB

  factory: process.env.FACTORY,  //PancakeSwap V2 factory

  router: process.env.ROUTER, //PancakeSwap V2 router

  recipient: process.env.YOUR_ADDRESS, //your wallet address,

  Slippage: process.env.SLIPPAGE, //in Percentage

  gasPrice: ethers.utils.parseUnits(`${process.env.GWEI}`, 'gwei'), //in gwei

  gasLimit: process.env.GAS_LIMIT, //at least 21000

  minBnb: process.env.MIN_LIQUIDITY_ADDED //min liquidity added
}

let initialLiquidityDetected = false;
let jmlBnb = 0;

const wss = process.env.WSS_NODE;
const rpc = process.env.RPC_NODE;
const connection = process.env.USE_WSS;
const mnemonic = process.env.YOUR_MNEMONIC //your memonic;
const tokenIn = data.to_PURCHASE;
const tokenOut = data.BNB;
let provider;
const EXPECTED_PONG_BACK = 15000
const KEEP_ALIVE_CHECK_INTERVAL = 7500
const startConnection = () => {
  provider = new ethers.providers.WebSocketProvider(wss)

  let pingTimeout = null
  let keepAliveInterval = null

  provider._websocket.on('open', () => {
    keepAliveInterval = setInterval(() => {
      console.log('Checking if the connection is alive, sending a ping')

      provider._websocket.ping()

      // Use `WebSocket#terminate()`, which immediately destroys the connection,
      // instead of `WebSocket#close()`, which waits for the close timer.
      // Delay should be equal to the interval at which your server
      // sends out pings plus a conservative assumption of the latency.
      pingTimeout = setTimeout(() => {
        provider._websocket.terminate()
      }, EXPECTED_PONG_BACK)
    }, KEEP_ALIVE_CHECK_INTERVAL)

    // TODO: handle contract listeners setup + indexing
  })

  provider._websocket.on('close', () => {
    console.log('The websocket connection was closed')
    clearInterval(keepAliveInterval)
    clearTimeout(pingTimeout)
    startConnection()
  })

  provider._websocket.on('pong', () => {
    console.log('Received pong, so connection is alive, clearing the timeout')
    clearInterval(pingTimeout)
  })
}

if (connection === '1') {
  startConnection();
} else {
  provider = new ethers.providers.JsonRpcProvider(rpc);
}

const wallet = new ethers.Wallet(mnemonic);
const account = wallet.connect(provider);


const factory = new ethers.Contract(
  data.factory,
  [
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'function allPairsLength() external view returns (uint)'
  ],
  account
);

const router = new ethers.Contract(
  data.router,
  [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline) external  payable returns (uint[] memory amounts)',
    'function swapExactETHForTokens( uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function price1CumulativeLast() external view returns (uint)', 'function totalSupply() external view returns (uint)'
  ],
  account
);

const erc = new ethers.Contract(
  data.BNB,
  [{ "constant": true, "inputs": [{ "name": "_owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "balance", "type": "uint256" }], "payable": false, "type": "function" }],
  account
);


const delay = (t) => {
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve(true);
    }, t);
  });
};

const run = async () => {
  await checkLiq();
}

const getPrice = async () => {
  const amountIn = ethers.utils.parseUnits('1', 'ether');
  const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
  return Number(amounts[1].toString() / Number(amountIn.toString()));
}

let checkLiq = async () => {
  const currentPrice = await getPrice();
  console.log(chalk.bgRedBright(`Current price: ${currentPrice}`));
  const pairAddressx = await factory.getPair(tokenIn, tokenOut);
  console.log(chalk.blue(`pairAddress: ${pairAddressx}`));
  if (pairAddressx !== null && pairAddressx !== undefined) {
    // console.log("pairAddress.toString().indexOf('0x0000000000000')", pairAddress.toString().indexOf('0x0000000000000'));
    if (pairAddressx.toString().indexOf('0x0000000000000') > -1) {
      console.log(chalk.cyan(`pairAddress ${pairAddressx} not detected. Auto restart`));
      return await run();
    }
  }
  const pairBNBvalue = await erc.balanceOf(pairAddressx);
  jmlBnb = await ethers.utils.formatEther(pairBNBvalue);
  console.log(`value BNB : ${jmlBnb}`);

  if (parseFloat(jmlBnb) > parseFloat(data.minBnb) && currentPrice >= 0.1) {
    setTimeout(() => buyAction(), 3000);
  }
  else {
    await delay(20000);
    initialLiquidityDetected = false;
    console.log(' run again...');
    return await run();
  }
}

let buyAction = async () => {
  if (initialLiquidityDetected === true) {
    console.log('not buy cause already buy');
    return null;
  }

  console.log('ready to buy');
  try {
    initialLiquidityDetected = true;

    let amountOutMin = 0;
    //We buy x amount of the new token for our bnb
    const amountIn = ethers.utils.parseUnits(`${data.AMOUNT_OF_BNB}`, 'ether');
    if (parseInt(data.Slippage) !== 0) {
      const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
      //Our execution price will be a bit different, we need some flexibility
      amountOutMin = amounts[1].sub(amounts[1].div(`${data.Slippage}`))
    }

    console.log(
      chalk.green.inverse(`Start to buy \n`)
      +
      `Buying Token
        =================
        tokenIn: ${(amountIn * 1e-18).toString()} ${tokenIn} (BNB)
        tokenOut: ${amountOutMin.toString()} ${tokenOut}
      `);

    console.log('Processing Transaction.....');
    console.log(chalk.yellow(`amountIn: ${(amountIn * 1e-18)} ${tokenIn} (BNB)`));
    console.log(chalk.yellow(`amountOutMin: ${amountOutMin}`));
    console.log(chalk.yellow(`tokenIn: ${tokenIn}`));
    console.log(chalk.yellow(`tokenOut: ${tokenOut}`));
    console.log(chalk.yellow(`data.recipient: ${data.recipient}`));
    console.log(chalk.yellow(`data.gasLimit: ${data.gasLimit}`));
    console.log(chalk.yellow(`data.gasPrice: ${data.gasPrice}`));

    // const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens( //uncomment this if you want to buy deflationary token
    // const tx = await router.swapExactETHForTokens
    // console.log(amountIn, amountOutMin);
    const tx = await router.swapExactTokensForTokens( //uncomment here if you want to buy token
      amountIn, amountOutMin,
      [tokenIn, tokenOut],
      data.recipient,
      Date.now() + 1000 * 60 * 5, //5 minutes
      {
        'gasLimit': data.gasLimit,
        'gasPrice': data.gasPrice,
        'nonce': null, //set you want buy at where position in blocks
        // 'value': amountIn
      });

    const receipt = await tx.wait();
    console.log(`Transaction receipt : https://www.bscscan.com/tx/${receipt.logs[1].transactionHash}`);
//     setTimeout(() => { process.exit() }, 2000);
  } catch (err) {
    let error = JSON.parse(JSON.stringify(err));
    console.log(`Error caused by : 
        {
        reason : ${error.reason},
        transactionHash : ${error.transactionHash}
        message : ${error}
        }`);
    console.log(error);

    inquirer.prompt([
      {
        type: 'confirm',
        name: 'runAgain',
        message: 'Do you want to run again thi bot?',
      },
    ])
      .then(answers => {
        if (answers.runAgain === true) {
          console.log('= = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =');
          console.log('Run again');
          console.log('= = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =');
          initialLiquidityDetected = false;
          run();
        } else {
          process.exit();
        }

      });

  console.log('= = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =');
  console.log('Run again');
  console.log('= = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =');
  initialLiquidityDetected = false;
  run();

  }
}

run();

const PORT = 5001;

app.listen(PORT, console.log(chalk.yellow(`Listening for Liquidity Addition to token ${data.to_PURCHASE}`)));
