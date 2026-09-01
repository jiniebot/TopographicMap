Code i found online: 

RC4.h
Code:
#pragma once
 
class CRandomMantissa
{
private:
	const float m_fMagicConstant = 0.000000000465661F; // equals 0x30000000 as an integer ( it also happens to be the ratio between, 1 nibble into 1 gigabyte )
	int m_iSeed;
 
public:
	void SetSeed(int iSeed);
	float Next();
};
 
class CRC4
{
private:
	union UBohemiaKey
	{
		unsigned char m_uByteKey[16];
		unsigned int m_uIntKey[4];
	};
 
	UBohemiaKey m_bKey, m_bDefaultKey;
 
	CRandomMantissa rNumberGenerator;
 
	int m_iSeed, m_pDefaultState[256];
 
	__int64 m_iBufferSize;
 
	int GetChunkSeed(__int64 iChunkPosition);
	void SwapIndices(int *pBuffer, int iSource, int iDestination);
 
public:
	CRC4(const unsigned char pEncryptionKey[16], __int64 iBufferSize);
 
	void DecryptChunk(unsigned char *pChunkData, unsigned int uChunkSize, __int64 iChunkPosition);
};
RC4.cpp
Code:
#include "RC4.h"
 
#include <algorithm>
 
#pragma region CRandomMantissa
void CRandomMantissa::SetSeed(int iSeed)
{
	m_iSeed = iSeed;
}
 
float CRandomMantissa::Next()
{
	// & 0b011111111111111111111111 preserve the last 23 bits only, ( basically it's only taking the mantissa from the float )
	m_iSeed = (12345 - (1043968403 * m_iSeed)) & 0b01111111111111111111111111111111;
	return m_iSeed * m_fMagicConstant;
}
#pragma endregion
 
#pragma region CRC4
// Seemingly random operations to generate a seed based off file size.
// EBO -> PBO and PBO -> EBO with relative ease via XOR because it's a stream cipher.
CRC4::CRC4(const unsigned char pEncryptionKey[16], __int64 iBufferSize) :
	m_iBufferSize(iBufferSize),
	m_iSeed(iBufferSize ^ (iBufferSize << (-(char)iBufferSize & 0b00000111) | iBufferSize >> (iBufferSize >> 3 & 0b00000111)))
{
	memcpy(m_bKey.m_uByteKey, pEncryptionKey, sizeof(UBohemiaKey));
	memcpy(m_bDefaultKey.m_uByteKey, pEncryptionKey, sizeof(UBohemiaKey));
 
	for (int i = 0; i < 256; i++)
		m_pDefaultState[i] = i;
}
 
// [Private]:
 
int CRC4::GetChunkSeed(__int64 iChunkPosition)
{
	// If someone could explain this [removed] to me I would grateful.
	// Could just be another layer of randomization based off the current iteration?
	/*  every bit of information I gathered...
		* 256.0F, ( to get the random number in bytes? )
		- 0.5F. ( so it forces a round down maybe? )
		+ 12582912.0F, 12582912 bytes = 12 megabytes.
 
		& 0b011111111111111111111111 preserve the last 23 bits only, ( it's only taking the mantissa from the float )
 
		+ 4290772992, 4290772992 bytes = 4190208 kilobytes = 4092 megabytes.
		+ 256, assuming bytes here.
	*/
	rNumberGenerator.SetSeed(iChunkPosition ^ m_iSeed);
	return std::clamp<int>((static_cast<int>(rNumberGenerator.Next() * 256.0F - 0.5F + 12582912.0F) & 0b011111111111111111111111) + 4290772992 + 256, 256, 512 - 1);
}
 
void CRC4::SwapIndices(int *pBuffer, int iSource, int iDestination)
{
	unsigned int uTemp = pBuffer[iDestination];
 
	pBuffer[iDestination] = pBuffer[iSource];
	pBuffer[iSource] = uTemp;
}
 
// [Public]:
 
void CRC4::DecryptChunk(unsigned char *pChunkData, unsigned int uChunkSize, __int64 iChunkPosition)
{
	// Copy default state
	int pTempState[256];
	memcpy(pTempState, m_pDefaultState, sizeof(m_pDefaultState));
 
	// Restore key
	memcpy(&m_bKey, &m_bDefaultKey, sizeof(UBohemiaKey));
 
	for (int i = 0; i < sizeof(UBohemiaKey) / 4; i++)
		m_bKey.m_uIntKey[i] ^= iChunkPosition ^ (~m_iSeed);
 
	// Key Scheduling
	unsigned char iTempIndex = 0;
	for (int i = 0; i < 256; i++)
	{
		iTempIndex += pTempState[i] + m_bKey.m_uByteKey[i % sizeof(UBohemiaKey)];
		SwapIndices(pTempState, iTempIndex, i);
	}
 
	/*
	- [Douggem] :
	{
		[removed]ing dirty hax.  BI sign extends bytes into DWORDS then chopps off only the lowest byte
		All these [removed]ing bitwise ands and [removed]...just an attempt to mirror what's going on internally in ArmA
		[removed]ing dirty goddamn hax
	}
	*/
 
	// Pseudo random obfuscation layer aka (stream generation)
	int iSourceIndex = 0, iDestinationIndex = 0;
 
	for (int i = 0; i < GetChunkSeed(iChunkPosition); i++)
	{
		iSourceIndex++;
		iDestinationIndex = iDestinationIndex + pTempState[iSourceIndex & 0xFF] & 0xFF;
		SwapIndices(pTempState, iSourceIndex & 0xFF, iDestinationIndex & 0xFF);
	}
 
	// Swap Indices
	iSourceIndex ^= iDestinationIndex;
	iDestinationIndex ^= iSourceIndex;
	iSourceIndex ^= iDestinationIndex;
 
	// Decryption
	for (int i = 0; i < uChunkSize; i++)
	{
		iSourceIndex++;
		iDestinationIndex = iDestinationIndex + pTempState[iSourceIndex & 0xFF] & 0xFF;
		SwapIndices(pTempState, iSourceIndex & 0xFF, iDestinationIndex & 0xFF);
 
		iTempIndex = pTempState[iSourceIndex & 0xFF] + pTempState[iDestinationIndex & 0xFF];
		pChunkData[i] ^= pTempState[iTempIndex];
	}
}
 
#pragma endregion
EBO.h
Code:
#pragma once
 
#include <vector>
#include <fstream>
 
class CEncryptedBankOfFiles
{
private:
	struct SPBOHeader
	{
		char m_pData[21];
	};
	struct SChunk
	{
		__int64 m_iChunkPosition;
		unsigned char m_pChunk[4096];
		int m_iChunkSize;
 
		SChunk(__int64 iChunkPosition, int iChunkSize) :
			m_iChunkPosition(iChunkPosition),
			m_pChunk{ 0x0 }, m_iChunkSize(iChunkSize) { }
	};
 
	std::string m_sEboPath;
	std::fstream m_fEbo;
	__int64 m_iEboSize;
 
	int m_iHeaderSize;
 
	std::vector<SChunk> m_vChunks;
	int m_iChunkCount;
 
	void EmplaceChunk(int iSize, __int64 iPosition);
	void GenerateChunks();
 
	void Decrypt();
 
public:
	CEncryptedBankOfFiles(std::string sFilePath);
	~CEncryptedBankOfFiles();
 
	void CreatePbo();
};
 
typedef CEncryptedBankOfFiles CEncryptedBank;
EBO.cpp
Code:
#include "EBO.h"
 
#include "RC4.h"
 
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
 
constexpr unsigned char g_cDayZKey[16] = { 0x8F, 0x06, 0xAD, 0x83, 0xD6, 0xCD, 0xC3, 0x3F, 0xE4, 0x19, 0xBF, 0xEC, 0x3F, 0x26, 0x7C, 0x43 };
//constexpr unsigned char g_cArma3Key[16] = { 0x0E, 0xE2, 0x6D, 0x27, 0x95, 0x69, 0xC5, 0x9A, 0x0D, 0xCF, 0x6D, 0x55, 0x03, 0xBA, 0x80, 0xD9 };
 
#pragma region CEBO
CEncryptedBankOfFiles::CEncryptedBankOfFiles(std::string sFilePath) :
	m_sEboPath(sFilePath), m_fEbo(m_sEboPath, std::ios::in | std::ios::out | std::ios::binary)
{
	if (m_fEbo.fail() || !m_fEbo.is_open())
		throw 1;
 
	// Get the file size with the windows fileapi.
	WIN32_FIND_DATA wFindData;
	FindClose(FindFirstFileA(m_sEboPath.c_str(), &wFindData));
	m_iEboSize = wFindData.nFileSizeLow | (__int64)wFindData.nFileSizeHigh << 32;
 
	// Rather than this way. ( which is super slow because of "ignore" ).
	//m_fEbo.ignore(INT64_MAX);
	//m_iEboSize = m_fEbo.gcount();
	//m_fEbo.clear();
	//m_fEbo.seekg(0, std::ios_base::beg);
 
	if (m_iEboSize <= 0)
		throw 2;
 
	GenerateChunks();
 
	if (m_vChunks.empty())
		throw 3;
 
	Decrypt();
}
CEncryptedBankOfFiles::~CEncryptedBankOfFiles()
{
	if (m_fEbo.is_open())
		m_fEbo.close();
}
 
// [Private]:
 
void CEncryptedBankOfFiles::EmplaceChunk(int iSize, __int64 iPosition)
{
	SChunk &cTemp = m_vChunks.emplace_back(iPosition, iSize);
	m_fEbo.read((char*)cTemp.m_pChunk, cTemp.m_iChunkSize);
}
void CEncryptedBankOfFiles::GenerateChunks()
{
	// Skips the pbo header.
	// The header isn't encrypted, so there isn't a need to decrypt it.
	m_fEbo.seekp(sizeof(SPBOHeader), std::ios::cur);
 
	while (m_fEbo.get() != '\0')
		m_fEbo.ignore(INT64_MAX, m_fEbo.widen('\0'));
 
	m_iHeaderSize = (int)m_fEbo.tellg();
 
	// Chunkify the pbo into 4096 byte chunks.
	// The magic addtion and division is to make sure it's rounded up rather than down contrary to typical integer arithmetic.
	m_iChunkCount = (int)(m_iEboSize - m_iHeaderSize + 4095) / 4096;
	m_vChunks.reserve(m_iChunkCount);
 
	// The encryption considers this as the beginning, so chunk position has to be 0.
	// For some reason they subtract the header size aka the body offset.
	// Because of this the bottom of the file ( the size of the header ) is actually not encrypted. ( maybe a footer? )
	EmplaceChunk(4096 - m_iHeaderSize, 0);
 
	for (int i = 1; i < m_iChunkCount - 1; i++)
		EmplaceChunk(4096, m_fEbo.tellg());
 
	// Gets the last chunk, that is the remainder in size
	EmplaceChunk((m_iEboSize - m_iHeaderSize) % 4096, m_fEbo.tellg());
 
	m_fEbo.seekg(0, std::ios::beg);
}
 
void CEncryptedBankOfFiles::Decrypt()
{
	CRC4 bRC4(g_cDayZKey, m_iEboSize);
 
	for (SChunk &cChunk : m_vChunks)
		bRC4.DecryptChunk(cChunk.m_pChunk, cChunk.m_iChunkSize, cChunk.m_iChunkPosition);
}
 
// [Public]:
 
// This could be way faster by not copying the whole file first lol.
// Only did that to preserve the header and "footer".
void CEncryptedBankOfFiles::CreatePbo()
{
	std::string sPboFilePath = m_sEboPath;
	sPboFilePath.replace(sPboFilePath.find_last_of('.') + 1, 3, "pbo");
 
	std::fstream fPbo(sPboFilePath, std::ios::out | std::ios::binary);
 
	if (!fPbo.fail() && fPbo.is_open())
	{
		fPbo << m_fEbo.rdbuf();
 
		fPbo.seekg(m_iHeaderSize, std::ios::beg);
 
		for (SChunk &cChunk : m_vChunks)
			fPbo.write((const char*)cChunk.m_pChunk, cChunk.m_iChunkSize);
	}
}
#pragma endregion
example.cpp
Code:
#include "EBO.h"
 
int main()
{
	try { CEncryptedBank("ebo file path here").CreatePbo(); }
	catch (int iException) { printf("Problem occurred, error code: %d\n", iException); return iException; }
 
	return 0;
}
I left the current Arma 3 encryption key in there so if you're working with Arma 3 just replace the key with that one and it should work, have fun!