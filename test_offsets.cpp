#include <stdio.h>
#include <stddef.h>
#include "include/vose_core.h"

int main() {
    printf("sizeof NoteEvent: %zu\n", sizeof(NoteEvent));
    printf("OFF_WAV_PATH: %zu\n", offsetof(NoteEvent, wav_path));
    printf("OFF_PITCH_CURVE: %zu\n", offsetof(NoteEvent, pitch_curve));
    printf("OFF_PITCH_LENGTH: %zu\n", offsetof(NoteEvent, pitch_length));
    printf("OFF_GENDER_CURVE: %zu\n", offsetof(NoteEvent, gender_curve));
    return 0;
}
