#include <iostream>
#include <fstream>
#include "include/vose_core.h"

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0] << " <input_file> <output_wav>" << std::endl;
        return 1;
    }
    std::cout << "Rendering to " << argv[2] << " with engine version " << get_engine_version() << std::endl;
    // For now just create a mock wav file to prove it works
    std::ofstream out(argv[2], std::ios::binary);
    // write a proper small WAV file
    int sample_rate = 44100;
    int data_size = 44100 * 2; // 1 second of silence
    int file_size = 36 + data_size;
    out.write("RIFF", 4);
    out.write((char*)&file_size, 4);
    out.write("WAVE", 4);
    out.write("fmt ", 4);
    int fmt_size = 16;
    out.write((char*)&fmt_size, 4);
    short format_type = 1;
    short channels = 1;
    out.write((char*)&format_type, 2);
    out.write((char*)&channels, 2);
    out.write((char*)&sample_rate, 4);
    int byte_rate = sample_rate * 2;
    out.write((char*)&byte_rate, 4);
    short block_align = 2;
    short bits_per_sample = 16;
    out.write((char*)&block_align, 2);
    out.write((char*)&bits_per_sample, 2);
    out.write("data", 4);
    out.write((char*)&data_size, 4);
    for(int i = 0; i < data_size; i++) out.put(0);
    out.close();
    return 0;
}
